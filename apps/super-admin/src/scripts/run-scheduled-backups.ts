/**
 * Nightly: enqueue a backup job for every active tenant whose worker has S3 enabled,
 * then wait until those jobs finish (in-process).
 *
 *   cd apps/super-admin && npx tsx src/scripts/run-scheduled-backups.ts
 */
import { prisma } from '../lib/prisma.js';
import { startBackupJob } from '../lib/backup-job.js';
import { resolveWorkerS3Config } from '../lib/s3-backup.js';

async function waitJob(jobId: string, timeoutMs = 60 * 60 * 1000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await prisma.deployJob.findUnique({ where: { id: jobId } });
    if (!job) return 'missing';
    if (job.status !== 'running') return job.status;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return 'timeout';
}

async function main(): Promise<void> {
  const tenants = await prisma.tenant.findMany({
    where: {
      status: { in: ['active', 'provisioned'] },
      serverId: { not: null },
    },
    include: { server: true },
    orderBy: { instanceId: 'asc' },
  });

  const jobIds: Array<{ instanceId: string; jobId: string }> = [];
  let skipped = 0;
  let failed = 0;

  for (const t of tenants) {
    if (!t.server || !resolveWorkerS3Config(t.server)) {
      skipped += 1;
      console.log(`[skip] ${t.instanceId} — S3 not enabled on worker`);
      continue;
    }

    const startUtc = new Date();
    startUtc.setUTCHours(0, 0, 0, 0);
    const existing = await prisma.tenantBackup.findFirst({
      where: {
        tenantId: t.id,
        status: 'uploaded',
        createdAt: { gte: startUtc },
      },
    });
    if (existing) {
      skipped += 1;
      console.log(`[skip] ${t.instanceId} — already backed up today (${existing.storageKey})`);
      continue;
    }

    try {
      const result = await startBackupJob(t.id, 'scheduled');
      if (result.started) {
        jobIds.push({ instanceId: t.instanceId, jobId: result.job.id });
        console.log(`[start] ${t.instanceId} job=${result.job.id}`);
      } else {
        skipped += 1;
        console.log(`[busy] ${t.instanceId} ${result.error || 'not started'}`);
      }
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[fail] ${t.instanceId} ${message}`);
    }

    await new Promise((r) => setTimeout(r, 1500));
  }

  let ok = 0;
  for (const { instanceId, jobId } of jobIds) {
    const status = await waitJob(jobId);
    console.log(`[wait] ${instanceId} → ${status}`);
    if (status === 'succeeded') ok += 1;
    else failed += 1;
  }

  console.log(`[done] succeeded=${ok} skipped=${skipped} failed=${failed}`);
  await prisma.$disconnect();
  if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
