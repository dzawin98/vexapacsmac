import { FastifyPluginCallback } from 'fastify';
import { createSrReportSeries } from '../dimse/srReport';
import { LoggerSingleton } from '../utils/logger';

const logger = LoggerSingleton.Instance;

const routes: FastifyPluginCallback = function (server, _opts, done) {
  server.post('/api/reports/sr', async (req, reply) => {
    try {
      const result = await createSrReportSeries((req.body || {}) as any);
      return reply.code(201).send(result);
    } catch (error) {
      logger.error(error);
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(message.includes('required') ? 400 : 500).send({ error: message });
    }
  });

  done();
};

module.exports = routes;
