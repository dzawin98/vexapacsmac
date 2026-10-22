import { FastifyPluginCallback } from 'fastify';
import { deactivateWorklist, getWorklist, listWorklists, MwlQuery, saveWorklist } from '../mwl/store';
import { LoggerSingleton } from '../utils/logger';

const logger = LoggerSingleton.Instance;
const { verifyRuntimeModule } = require('../../../scripts/license/licenseRuntime');

function ensureMwlLicensed(reply: any): boolean {
  const result = verifyRuntimeModule('PACS_MWL');
  if (result.ok) return true;
  reply.code(403).send({
    error: 'License is not valid for the MWL module.',
    code: result.reason || 'LICENSE_INVALID',
  });
  return false;
}

const routes: FastifyPluginCallback = function (server, _opts, done) {
  server.get('/mwl/health', async (_req, reply) => {
    if (!ensureMwlLicensed(reply)) return;
    return reply.send({ status: 'ok', service: 'dicomweb-pacs-mwl' });
  });

  server.post('/mwl/worklists', async (req, reply) => {
    if (!ensureMwlLicensed(reply)) return;
    try {
      const record = await saveWorklist((req.body || {}) as Record<string, unknown>);
      return reply.code(201).send({
        ID: record.id,
        Path: `/mwl/worklists/${record.id}`,
        Status: 'stored',
        Record: record,
      });
    } catch (error) {
      logger.error(error);
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.get<{
    Querystring: MwlQuery;
  }>('/mwl/worklists', async (req, reply) => {
    if (!ensureMwlLicensed(reply)) return;
    try {
      return reply.send(await listWorklists(req.query));
    } catch (error) {
      logger.error(error);
      return reply.code(500).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.get<{
    Params: { id: string };
  }>('/mwl/worklists/:id', async (req, reply) => {
    if (!ensureMwlLicensed(reply)) return;
    const record = await getWorklist(req.params.id);
    if (!record) {
      return reply.code(404).send({ error: 'MWL entry not found' });
    }
    return reply.send(record);
  });

  server.delete<{
    Params: { id: string };
  }>('/mwl/worklists/:id', async (req, reply) => {
    if (!ensureMwlLicensed(reply)) return;
    const record = await deactivateWorklist(req.params.id);
    if (!record) {
      return reply.code(404).send({ error: 'MWL entry not found' });
    }
    return reply.send({ ID: record.id, Status: 'inactive' });
  });

  done();
};

module.exports = routes;
