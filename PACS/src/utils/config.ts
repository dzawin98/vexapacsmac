import conf from 'config';

export enum ConfParams {
  LOG_DIR,
  STORAGE_PATH,
  XTRANSFER,
  MIMETYPE,
  SOURCE,
  PEERS,
  VERBOSE,
  MIN_CHARS,
  APPEND_WILDCARD,
  HTTP_PORT,
  HTTP_IP,
  PERMISSIVE,
  DIMSE_OUTBOUND_COMPRESSION,
  DIMSE_STORAGE_COMPRESSION,
  DIMSE_STORAGE_TRANSFER_SYNTAX,
}

const confDef = new Map<ConfParams, string[]>([
  [ConfParams.LOG_DIR, ['logDir']],
  [ConfParams.STORAGE_PATH, ['storagePath']],
  [ConfParams.XTRANSFER, ['transferSyntax']],
  [ConfParams.MIMETYPE, ['mimeType']],
  [ConfParams.SOURCE, ['source']],
  [ConfParams.PEERS, ['peers']],
  [ConfParams.VERBOSE, ['verboseLogging']],
  [ConfParams.MIN_CHARS, ['qidoMinChars']],
  [ConfParams.APPEND_WILDCARD, ['qidoAppendWildcard']],
  [ConfParams.HTTP_PORT, ['webserverPort', 'httpPort']],
  [ConfParams.HTTP_IP, ['httpIp']],
  [ConfParams.PERMISSIVE, ['permissiveMode']],
  [ConfParams.DIMSE_OUTBOUND_COMPRESSION, ['dimseOutboundCompression']],
  [ConfParams.DIMSE_STORAGE_COMPRESSION, ['dimseStorageCompression']],
  [ConfParams.DIMSE_STORAGE_TRANSFER_SYNTAX, ['dimseStorageTransferSyntax']],
]);

const envDef = new Map<ConfParams, string[]>([
  [ConfParams.LOG_DIR, ['DICOMWEB_PACS_LOG_DIR', 'PACS_LOG_DIR']],
  [ConfParams.STORAGE_PATH, ['DICOMWEB_PACS_STORAGE_PATH', 'DICOM_STORAGE_PATH']],
  [ConfParams.XTRANSFER, ['DICOMWEB_PACS_TRANSFER_SYNTAX', 'DICOM_TRANSFER_SYNTAX']],
  [ConfParams.MIMETYPE, ['DICOMWEB_PACS_MIME_TYPE']],
  [ConfParams.VERBOSE, ['DICOMWEB_PACS_VERBOSE_LOGGING']],
  [ConfParams.MIN_CHARS, ['DICOMWEB_PACS_QIDO_MIN_CHARS']],
  [ConfParams.APPEND_WILDCARD, ['DICOMWEB_PACS_QIDO_APPEND_WILDCARD']],
  [ConfParams.HTTP_PORT, ['PORT', 'DICOMWEB_PACS_PORT']],
  [ConfParams.HTTP_IP, ['HOST', 'DICOMWEB_PACS_HOST']],
  [ConfParams.PERMISSIVE, ['DICOMWEB_PACS_PERMISSIVE_MODE']],
  [ConfParams.DIMSE_OUTBOUND_COMPRESSION, ['DICOMWEB_DIMSE_OUTBOUND_COMPRESSION']],
  [ConfParams.DIMSE_STORAGE_COMPRESSION, ['DICOMWEB_DIMSE_STORAGE_COMPRESSION']],
  [ConfParams.DIMSE_STORAGE_TRANSFER_SYNTAX, ['DICOMWEB_DIMSE_STORAGE_TRANSFER_SYNTAX']],
]);

interface IConfig {
  get<T>(setting: ConfParams): T;
  has(setting: ConfParams): boolean;
}

class Config implements IConfig {
  private coerceEnvValue(setting: ConfParams, value: string): unknown {
    if ([ConfParams.VERBOSE, ConfParams.APPEND_WILDCARD, ConfParams.PERMISSIVE, ConfParams.DIMSE_OUTBOUND_COMPRESSION, ConfParams.DIMSE_STORAGE_COMPRESSION].includes(setting)) {
      return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
    }

    if ([ConfParams.MIN_CHARS, ConfParams.HTTP_PORT].includes(setting)) {
      const numberValue = Number(value);
      return Number.isFinite(numberValue) ? numberValue : value;
    }

    return value;
  }

  private resolveKey(setting: ConfParams): string {
    const keys = confDef.get(setting);
    if (!keys) {
      throw new Error(`Unknown config setting: ${setting}`);
    }

    for (const key of keys) {
      if (conf.has(key)) {
        return key;
      }
    }

    throw new Error(`Missing config setting: ${setting}`);
  }

  get<T>(setting: ConfParams): T {
    const envKeys = envDef.get(setting) || [];
    for (const envKey of envKeys) {
      const value = process.env[envKey];
      if (value !== undefined && value !== '') {
        return this.coerceEnvValue(setting, value) as T;
      }
    }

    return conf.get<T>(this.resolveKey(setting));
  }

  has(setting: ConfParams): boolean {
    const keys = confDef.get(setting);
    return keys ? keys.some((key) => conf.has(key)) : false;
  }
}

export const config = new Config();
