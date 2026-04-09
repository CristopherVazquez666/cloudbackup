#!/usr/bin/env node

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const crypto = require('crypto');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const CONFIG_PATH = process.env.BOVEDIX_AGENT_CONFIG || '/opt/bovedix-agent/etc/config.json';

function log(message, extra = null) {
  const stamp = new Date().toISOString();
  if (extra === null || extra === undefined) {
    console.log(`[${stamp}] ${message}`);
    return;
  }
  console.log(`[${stamp}] ${message}`, extra);
}

function readConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const config = JSON.parse(raw);
  const required = [
    'orchestrator_url',
    'server_slug',
    'shared_secret',
    'remote_host',
    'remote_user',
    'remote_base_path',
    'ssh_key_path'
  ];

  for (const key of required) {
    if (!String(config[key] || '').trim()) {
      throw new Error(`Missing required config key: ${key}`);
    }
  }

  return {
    poll_interval_seconds: 15,
    remote_port: 22,
    pkgacct_path: '/scripts/pkgacct',
    local_temp_dir: '/var/tmp/bovedix-agent',
    ...config,
    orchestrator_url: String(config.orchestrator_url).replace(/\/+$/, '')
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildHeaders(config) {
  return {
    'Content-Type': 'application/json',
    'X-Bovedix-Server-Slug': config.server_slug,
    'X-Bovedix-Shared-Secret': config.shared_secret
  };
}

async function api(config, route, options = {}) {
  const response = await fetch(`${config.orchestrator_url}${route}`, {
    ...options,
    headers: {
      ...buildHeaders(config),
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(data?.error || `Request failed for ${route}`);
  }

  return data;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function runCommand(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      maxBuffer: 32 * 1024 * 1024,
      ...options
    });
    return result;
  } catch (error) {
    const stderr = String(error.stderr || '').trim();
    const stdout = String(error.stdout || '').trim();
    const detail = stderr || stdout || error.message;
    throw new Error(`${command} failed: ${detail}`);
  }
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function cleanupDir(dirPath) {
  await fsp.rm(dirPath, { recursive: true, force: true });
}

async function findGeneratedBackup(tmpDir, cpanelUser) {
  const expected = path.join(tmpDir, `cpmove-${cpanelUser}.tar.gz`);
  if (fs.existsSync(expected)) {
    return expected;
  }

  const files = await fsp.readdir(tmpDir);
  const match = files.find((file) => file.startsWith(`cpmove-${cpanelUser}`));
  if (!match) {
    throw new Error(`No backup archive found for ${cpanelUser}`);
  }

  return path.join(tmpDir, match);
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function ensureRemoteDir(config, remoteDir) {
  const sshArgs = [
    '-i', config.ssh_key_path,
    '-p', String(config.remote_port),
    '-o', 'StrictHostKeyChecking=accept-new',
    `${config.remote_user}@${config.remote_host}`,
    `mkdir -p ${shellQuote(remoteDir)}`
  ];
  await runCommand('ssh', sshArgs);
}

async function rsyncFile(config, localFile, remoteFile) {
  const rsyncArgs = [
    '-az',
    '--partial',
    '-e',
    `ssh -i ${config.ssh_key_path} -p ${config.remote_port} -o StrictHostKeyChecking=accept-new`,
    localFile,
    `${config.remote_user}@${config.remote_host}:${remoteFile}`
  ];
  await runCommand('rsync', rsyncArgs);
}

async function runBackupJob(config, job) {
  const payload = job.payload || {};
  const cpanelUser = payload.cpanel_user || job.cpanel_user;

  if (!cpanelUser) {
    throw new Error('Backup job is missing cpanel_user');
  }

  const tmpDir = path.join(config.local_temp_dir, job.id);
  await cleanupDir(tmpDir);
  await ensureDir(tmpDir);

  try {
    log(`Running pkgacct for ${cpanelUser}`);
    await runCommand(config.pkgacct_path, [cpanelUser, tmpDir]);

    const localArchive = await findGeneratedBackup(tmpDir, cpanelUser);
    const stats = await fsp.stat(localArchive);
    const checksum = await sha256File(localArchive);
    const filename = path.basename(localArchive);
    const remoteDir = path.posix.join(config.remote_base_path, config.server_slug, cpanelUser);
    const remotePath = path.posix.join(remoteDir, filename);

    await ensureRemoteDir(config, remoteDir);
    log(`Uploading backup to ${config.remote_host}:${remotePath}`);
    await rsyncFile(config, localArchive, remotePath);

    return {
      filename,
      filesize: stats.size,
      kind: 'full',
      remote_path: remotePath,
      checksum,
      notes: `Created by bovedix-agent on ${new Date().toISOString()}`
    };
  } finally {
    await cleanupDir(tmpDir);
  }
}

async function processJob(config, job) {
  await api(config, `/api/agent/jobs/${job.id}/start`, { method: 'POST' });
  log(`Started job ${job.id} (${job.type}) for ${job.cpanel_user}`);

  try {
    if (job.type === 'backup') {
      const backup = await runBackupJob(config, job);
      await api(config, `/api/agent/jobs/${job.id}/complete`, {
        method: 'POST',
        body: JSON.stringify({
          log: `Backup created for ${job.cpanel_user}`,
          result: { remote_path: backup.remote_path, checksum: backup.checksum },
          backup
        })
      });
      log(`Completed backup job ${job.id}`);
      return;
    }

    throw new Error(`${job.type} is not supported by the trial agent yet`);
  } catch (error) {
    await api(config, `/api/agent/jobs/${job.id}/fail`, {
      method: 'POST',
      body: JSON.stringify({ error: error.message, log: error.message })
    });
    log(`Failed job ${job.id}: ${error.message}`);
  }
}

async function main() {
  const config = readConfig();
  await ensureDir(config.local_temp_dir);

  log(`Agent online for ${config.server_slug}`);
  await api(config, '/api/agent/status');

  const runOnce = process.argv.includes('--once');

  while (true) {
    try {
      const { job } = await api(config, '/api/agent/jobs/next');
      if (job) {
        await processJob(config, job);
      } else if (runOnce) {
        log('No queued jobs found');
        break;
      } else {
        await sleep(Number(config.poll_interval_seconds || 15) * 1000);
      }
    } catch (error) {
      log(`Agent loop error: ${error.message}`);
      if (runOnce) {
        process.exitCode = 1;
        break;
      }
      await sleep(Number(config.poll_interval_seconds || 15) * 1000);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
