import { FastifyPluginCallback } from 'fastify';
import { syncPacsMetadataForStudies, syncPacsMetadataFromStorage } from '../dimse/metadataDb';
import { LoggerSingleton } from '../utils/logger';

const logger = LoggerSingleton.Instance;

function isLoopbackAddress(value: string | undefined): boolean {
  const address = String(value || '').replace(/^::ffff:/, '');
  return address === '127.0.0.1' || address === '::1';
}

function requestedStudyUids(body: unknown): string[] {
  const payload = (body || {}) as Record<string, unknown>;
  const raw = payload.studies ?? payload.studyInstanceUids ?? payload.studyInstanceUid;
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  return Array.from(new Set(list.map((value) => String(value || '').trim()).filter(Boolean)));
}

const routes: FastifyPluginCallback = function (server, _opts, done) {
  server.post('/internal/metadata/sync', async (req, reply) => {
    if (!isLoopbackAddress(req.ip)) {
      return reply.code(403).send({ error: 'Metadata sync is available only from localhost' });
    }
    try {
      // A study list turns this into a bounded re-index of just those folders
      // (what a DICOM Manager merge needs). Without one, walk the whole archive.
      const studies = requestedStudyUids(req.body);
      if (studies.length) {
        const result = await syncPacsMetadataForStudies(studies);
        return reply.send({ status: 'synchronized', scoped: true, ...result });
      }
      await syncPacsMetadataFromStorage(true);
      return reply.send({ status: 'synchronized', scoped: false });
    } catch (error) {
      logger.error(`forced PACS metadata sync failed: ${error instanceof Error ? error.message : String(error)}`);
      return reply.code(500).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  done();
};

module.exports = routes;
