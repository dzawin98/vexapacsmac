import fs from 'fs/promises';
import path from 'path';
import dicomParser from 'dicom-parser';
import { recompress, recompressOptions } from 'dicom-dimse-native';
import { DicomResponse } from '../types';

const jpegLsLosslessTransferSyntax = '1.2.840.10008.1.2.4.80';
const defaultStudyInstanceUid = '1.2.826.0.1.3680043.10.5432.1781538491650.181287691';
const defaultSeriesInstanceUid = '1.3.12.2.1107.5.1.4.77167.30000025111005204500300048307';

interface DicomFileInfo {
  filePath: string;
  fileName: string;
  size: number;
  studyInstanceUid?: string;
  seriesInstanceUid?: string;
  sopInstanceUid?: string;
  transferSyntaxUid?: string;
  modality?: string;
}

interface CliOptions {
  sourceDir: string;
  outputDir: string;
  studyInstanceUid: string;
  seriesInstanceUid: string;
  limit: number;
  verbose: boolean;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const getValue = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };

  const studyInstanceUid = getValue('--study') || defaultStudyInstanceUid;
  const seriesInstanceUid = getValue('--series') || defaultSeriesInstanceUid;
  const storageRoot = process.env.VEXA_DICOM_STORAGE || process.env.PACS_STORAGE_PATH || 'D:\\VELOPACS-RIS\\DATA';
  const sourceDir = path.resolve(getValue('--source') || path.join(storageRoot, studyInstanceUid));
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = path.resolve(
    getValue('--out') ||
      path.join(storageRoot, '.compression-tests', 'jpeg-ls', studyInstanceUid, seriesInstanceUid, timestamp),
  );
  const limit = Number(getValue('--limit') || '0');
  const verbose = args.includes('--verbose');

  return {
    sourceDir,
    outputDir,
    studyInstanceUid,
    seriesInstanceUid,
    limit: Number.isFinite(limit) && limit > 0 ? limit : 0,
    verbose,
  };
}

async function readDicomInfo(filePath: string): Promise<DicomFileInfo | null> {
  try {
    const buffer = await fs.readFile(filePath);
    const dataSet = dicomParser.parseDicom(new Uint8Array(buffer));
    const stat = await fs.stat(filePath);

    return {
      filePath,
      fileName: path.basename(filePath),
      size: stat.size,
      studyInstanceUid: dataSet.string('x0020000d'),
      seriesInstanceUid: dataSet.string('x0020000e'),
      sopInstanceUid: dataSet.string('x00080018'),
      transferSyntaxUid: dataSet.string('x00020010'),
      modality: dataSet.string('x00080060'),
    };
  } catch {
    return null;
  }
}

async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

async function collectSeriesFiles(sourceDir: string, seriesInstanceUid: string): Promise<DicomFileInfo[]> {
  const files = await listFilesRecursive(sourceDir);
  const matches: DicomFileInfo[] = [];

  for (const filePath of files) {
    const info = await readDicomInfo(filePath);
    if (info?.seriesInstanceUid === seriesInstanceUid) {
      matches.push(info);
    }
  }

  return matches.sort((a, b) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true }));
}

async function recompressFile(inputFile: string, outputDir: string, verbose: boolean): Promise<void> {
  const options: recompressOptions & Record<string, unknown> = {
    sourcePath: inputFile,
    storagePath: outputDir,
    writeTransfer: jpegLsLosslessTransferSyntax,
    enableRecompression: true,
    verbose,
  };

  return new Promise((resolve, reject) => {
    recompress(options, (result: string) => {
      if (!result) {
        reject(new Error('dicom-dimse-native recompress returned an empty result'));
        return;
      }

      try {
        const json = JSON.parse(result) as DicomResponse;
        if (json.code === 0) {
          resolve();
          return;
        }
        reject(new Error(json.message || result));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(2)} MB`;
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${value} B`;
}

async function main() {
  const options = parseArgs();
  await fs.mkdir(options.outputDir, { recursive: true });

  const sourceFiles = await collectSeriesFiles(options.sourceDir, options.seriesInstanceUid);
  const selectedFiles = options.limit ? sourceFiles.slice(0, options.limit) : sourceFiles;

  if (!sourceFiles.length) {
    throw new Error(`No DICOM files found for SeriesInstanceUID ${options.seriesInstanceUid} in ${options.sourceDir}`);
  }

  console.log(`JPEG-LS Lossless test`);
  console.log(`Study : ${options.studyInstanceUid}`);
  console.log(`Series: ${options.seriesInstanceUid}`);
  console.log(`Input : ${options.sourceDir}`);
  console.log(`Output: ${options.outputDir}`);
  console.log(`Files : ${selectedFiles.length}${options.limit ? ` of ${sourceFiles.length}` : ''}`);

  const inputBytes = selectedFiles.reduce((sum, file) => sum + file.size, 0);
  console.log(`Input size: ${formatBytes(inputBytes)}`);
  console.log(`Input transfer syntax sample: ${selectedFiles[0].transferSyntaxUid || 'unknown'}`);

  let completed = 0;
  for (const file of selectedFiles) {
    await recompressFile(file.filePath, options.outputDir, options.verbose);
    completed += 1;
    if (completed === 1 || completed % 25 === 0 || completed === selectedFiles.length) {
      console.log(`Compressed ${completed}/${selectedFiles.length}`);
    }
  }

  const outputFiles = await listFilesRecursive(options.outputDir);
  const selectedSopUids = new Set(selectedFiles.map((file) => file.sopInstanceUid).filter(Boolean));
  const outputInfos: DicomFileInfo[] = [];

  for (const filePath of outputFiles) {
    const info = await readDicomInfo(filePath);
    if (info?.sopInstanceUid && selectedSopUids.has(info.sopInstanceUid)) {
      outputInfos.push(info);
    }
  }

  const outputBytes = outputInfos.reduce((sum, file) => sum + file.size, 0);
  const outputTransferSyntaxes = [...new Set(outputInfos.map((file) => file.transferSyntaxUid || 'unknown'))];

  console.log(`Output files matched: ${outputInfos.length}/${selectedFiles.length}`);
  console.log(`Output size: ${formatBytes(outputBytes)}`);
  console.log(`Output transfer syntax: ${outputTransferSyntaxes.join(', ')}`);

  if (outputInfos.length !== selectedFiles.length) {
    throw new Error('Output validation failed: not every input SOPInstanceUID was found in output');
  }

  if (outputTransferSyntaxes.length !== 1 || outputTransferSyntaxes[0] !== jpegLsLosslessTransferSyntax) {
    throw new Error(`Output validation failed: expected ${jpegLsLosslessTransferSyntax}`);
  }

  const ratio = outputBytes > 0 ? inputBytes / outputBytes : 0;
  const reduction = inputBytes > 0 ? (1 - outputBytes / inputBytes) * 100 : 0;
  console.log(`Compression ratio: ${ratio.toFixed(2)}x`);
  console.log(`Size reduction: ${reduction.toFixed(1)}%`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
