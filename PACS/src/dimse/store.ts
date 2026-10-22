import {
  Node as DicomNode,
  shutdownScu,
  shutdownScuOptions,
  startStoreScp,
  storeScpOptions,
} from 'dicom-dimse-native';
import { DicomResponse } from '../types';
import { ConfParams, config } from '../utils/config';
import { LoggerSingleton } from '../utils/logger';
import { requestMetadataSync } from './metadataDb';

export function startScp() {
  const logger = LoggerSingleton.Instance;
  const source = config.get<DicomNode>(ConfParams.SOURCE);
  const peers = config.get<DicomNode[]>(ConfParams.PEERS);
  const transferSyntax = config.get<string>(ConfParams.XTRANSFER);
  const outboundCompression = config.get<boolean>(ConfParams.DIMSE_OUTBOUND_COMPRESSION);
  const storageCompression = config.get<boolean>(ConfParams.DIMSE_STORAGE_COMPRESSION);
  const outboundTransferSyntax = outboundCompression ? '1.2.840.10008.1.2.4.90' : transferSyntax;
  const configuredStorageTransferSyntax = config.get<string>(ConfParams.DIMSE_STORAGE_TRANSFER_SYNTAX);
  const supportedStorageTransferSyntaxes = new Set([
    '1.2.840.10008.1.2.4.90',
    '1.2.840.10008.1.2.4.80',
  ]);
  const storageTransferSyntax = supportedStorageTransferSyntaxes.has(configuredStorageTransferSyntax)
    ? configuredStorageTransferSyntax
    : '1.2.840.10008.1.2.4.90';
  const storageCompressionName = storageTransferSyntax === '1.2.840.10008.1.2.4.80'
    ? 'JPEG-LS Lossless'
    : 'JPEG 2000 Lossless';

  const options: storeScpOptions = {
    source,
    peers: [...peers, source],
    storagePath: config.get<string>(ConfParams.STORAGE_PATH),
    permissive: config.get<boolean>(ConfParams.PERMISSIVE),
    verbose: config.get<boolean>(ConfParams.VERBOSE),
    netTransferPrefer: storageCompression ? storageTransferSyntax : transferSyntax,
    netTransferPropose: outboundTransferSyntax,
    ...(storageCompression ? { writeTransfer: storageTransferSyntax } : {}),
  };

  logger.info(`pacs-server listening on port: ${options.source.port}`);
  logger.info(
    `DIMSE outbound compression=${outboundCompression ? 'enabled' : 'disabled'} ` +
    `preferred=${outboundTransferSyntax}; storage compression=${storageCompression ? storageCompressionName : 'disabled'} ` +
    `(writeTransfer=${storageCompression ? storageTransferSyntax : 'original'})`,
  );
  startStoreScp(options, (result: string) => {
    if (!result) {
      return;
    }

    try {
      const parsed = JSON.parse(result);
      logger.info(parsed);
      if (parsed?.status === 'success') {
        // Debounced background walk: a whole study arriving over C-STORE used to
        // queue one full storage walk per instance, and every QIDO waited behind it.
        requestMetadataSync({ force: true, reason: 'c-store' });
      }
    } catch (error) {
      logger.error('failed to parse store-scp result', error);
      logger.error(result);
    }
  });
}

export async function shutdown(): Promise<void> {
  const logger = LoggerSingleton.Instance;
  const source = config.get<DicomNode>(ConfParams.SOURCE);
  const options: shutdownScuOptions = {
    source,
    target: source,
    verbose: config.get<boolean>(ConfParams.VERBOSE),
  };

  logger.info(`sending shutdown request to target: ${options.target.aet}`);

  return new Promise((resolve, reject) => {
    shutdownScu(options, (result: string) => {
      if (!result) {
        reject(new Error('invalid result received'));
        return;
      }

      try {
        const response = JSON.parse(result) as DicomResponse;
        if (response.code === 2) {
          logger.error(response.message);
          reject(new Error(response.message));
          return;
        }

        logger.info(response.message);
        resolve();
      } catch (error) {
        logger.error(result);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}
