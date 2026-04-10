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

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
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

async function rsyncFromRemote(config, remoteFile, localFile) {
  const rsyncArgs = [
    '-az',
    '--partial',
    '-e',
    `ssh -i ${config.ssh_key_path} -p ${config.remote_port} -o StrictHostKeyChecking=accept-new`,
    `${config.remote_user}@${config.remote_host}:${remoteFile}`,
    localFile
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

async function listMysqlDatabases(cpanelUser) {
  const prefix = String(cpanelUser || '').replace(/[_%]/g, '\\$&');
  const query = `SHOW DATABASES LIKE '${prefix}\\_%';`;
  const mysqlArgs = [];

  if (fs.existsSync('/root/.my.cnf')) {
    mysqlArgs.push('--defaults-file=/root/.my.cnf');
  }

  const { stdout } = await runCommand('mysql', [...mysqlArgs, '-NBe', query]);

  return String(stdout || '')
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
}

async function runUapi(cpanelUser, module, func, args = []) {
  const { stdout } = await runCommand('uapi', [
    `--user=${cpanelUser}`,
    module,
    func,
    ...args,
    '--output=jsonpretty'
  ]);

  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Could not parse UAPI response for ${module}.${func}`);
  }

  if (payload?.result?.status !== 1) {
    const detail = payload?.result?.errors?.join('; ') || payload?.result?.messages?.join('; ') || `${module}.${func} failed`;
    throw new Error(detail);
  }

  return payload.result.data || [];
}

async function detectMailStorageFormat(cpanelUser) {
  const homeDir = path.join('/home', cpanelUser);
  const mailRoot = path.join(homeDir, 'mail');
  const hintFile = path.join(mailRoot, 'mailbox_format.cpanel');
  const evidence = [];

  if (await pathExists(hintFile)) {
    const hint = String(await fsp.readFile(hintFile, 'utf8')).trim().toLowerCase();
    if (hint) {
      evidence.push(`mailbox_format.cpanel=${hint}`);
      if (hint.includes('mdbox')) {
        return { format: 'mdbox', evidence };
      }
      if (hint.includes('maildir')) {
        return { format: 'maildir', evidence };
      }
    }
  }

  const sampleRoots = await runCommand('bash', ['-lc', `find ${shellQuote(mailRoot)} -maxdepth 4 -type d \\( -name storage -o -name cur -o -name new -o -name tmp \\) | sed -n '1,80p'`]);
  const samplePaths = String(sampleRoots.stdout || '')
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);

  if (samplePaths.some((value) => /\/storage$/.test(value))) {
    evidence.push('storage-dir');
    return { format: 'mdbox', evidence };
  }

  if (samplePaths.some((value) => /\/(cur|new|tmp)$/.test(value))) {
    evidence.push('maildir-folders');
    return { format: 'maildir', evidence };
  }

  const specialFiles = await runCommand('bash', ['-lc', `find ${shellQuote(mailRoot)} -maxdepth 4 \\( -name mailboxes.db -o -name maildirfolder \\) | sed -n '1,80p'`]);
  const specialPaths = String(specialFiles.stdout || '')
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);

  if (specialPaths.some((value) => /mailboxes\.db$/.test(value))) {
    evidence.push('mailboxes.db');
    return { format: 'mdbox', evidence };
  }

  if (specialPaths.some((value) => /maildirfolder$/.test(value))) {
    evidence.push('maildirfolder');
    return { format: 'maildir', evidence };
  }

  return { format: 'unknown', evidence };
}

async function runMailBackupJob(config, job) {
  const payload = job.payload || {};
  const cpanelUser = payload.cpanel_user || job.cpanel_user;

  if (!cpanelUser) {
    throw new Error('Mail backup job is missing cpanel_user');
  }

  const homeDir = path.join('/home', cpanelUser);
  const mailRoot = path.join(homeDir, 'mail');
  const etcRoot = path.join(homeDir, 'etc');
  const tmpDir = path.join(config.local_temp_dir, job.id);
  const stagingDir = path.join(tmpDir, 'mail-backup');
  const stageMailDir = path.join(stagingDir, 'mail');
  const stageEtcDir = path.join(stagingDir, 'etc');

  await cleanupDir(tmpDir);
  await ensureDir(stageMailDir);
  await ensureDir(stageEtcDir);

  try {
    const domains = await runUapi(cpanelUser, 'Email', 'list_mail_domains');
    const mailboxes = await runUapi(cpanelUser, 'Email', 'list_pops_with_disk');
    const detected = await detectMailStorageFormat(cpanelUser);
    const domainNames = domains
      .map((entry) => String(entry.domain || '').trim())
      .filter(Boolean);

    if (!domainNames.length) {
      throw new Error(`No mail domains were found for ${cpanelUser}`);
    }

    log(`Preparing mail backup for ${cpanelUser}`, {
      format: detected.format,
      domains: domainNames,
      accounts: mailboxes.map((entry) => entry.email).filter(Boolean)
    });

    await runCommand('rsync', [
      '-a',
      '--delete',
      `${mailRoot}/`,
      `${stageMailDir}/`
    ]);

    for (const domain of domainNames) {
      const sourceConfigDir = path.join(etcRoot, domain);
      if (!(await pathExists(sourceConfigDir))) {
        continue;
      }
      const destinationConfigDir = path.join(stageEtcDir, domain);
      await ensureDir(destinationConfigDir);
      await runCommand('rsync', [
        '-a',
        '--delete',
        '--exclude',
        '*.rcube.db',
        `${sourceConfigDir}/`,
        `${destinationConfigDir}/`
      ]);
    }

    const manifest = {
      created_at: new Date().toISOString(),
      cpanel_user: cpanelUser,
      kind: 'mail',
      storage_format: detected.format,
      format_evidence: detected.evidence,
      domains: domainNames,
      mailboxes: mailboxes.map((entry) => ({
        email: entry.email,
        domain: entry.domain,
        diskused_mb: entry.diskused,
        diskquota_mb: entry.diskquota
      }))
    };

    await fsp.writeFile(
      path.join(stagingDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );

    const filename = `${cpanelUser}-mail-${detected.format}.tar.gz`;
    const localArchive = path.join(tmpDir, filename);
    await runCommand('tar', ['-czf', localArchive, '-C', stagingDir, '.']);

    const stats = await fsp.stat(localArchive);
    const checksum = await sha256File(localArchive);
    const remoteDir = path.posix.join(config.remote_base_path, config.server_slug, cpanelUser);
    const remotePath = path.posix.join(remoteDir, filename);

    await ensureRemoteDir(config, remoteDir);
    log(`Uploading mail backup to ${config.remote_host}:${remotePath}`);
    await rsyncFile(config, localArchive, remotePath);

    return {
      filename,
      filesize: stats.size,
      kind: 'mail',
      remote_path: remotePath,
      checksum,
      notes: `Mail backup (${detected.format}) for ${domainNames.join(', ')} created by bovedix-agent on ${new Date().toISOString()}`
    };
  } finally {
    await cleanupDir(tmpDir);
  }
}

async function runDatabaseBackupJob(config, job) {
  const payload = job.payload || {};
  const cpanelUser = payload.cpanel_user || job.cpanel_user;
  const requestedDatabase = String(payload.database_name || payload.database || '').trim();

  if (!cpanelUser) {
    throw new Error('Database backup job is missing cpanel_user');
  }

  const tmpDir = path.join(config.local_temp_dir, job.id);
  await cleanupDir(tmpDir);
  await ensureDir(tmpDir);

  try {
    const databases = await listMysqlDatabases(cpanelUser);

    if (!databases.length) {
      throw new Error(`No databases were found for ${cpanelUser}`);
    }

    const selectedDatabases = requestedDatabase
      ? databases.filter((database) => database === requestedDatabase)
      : databases;

    if (!selectedDatabases.length) {
      throw new Error(`Database ${requestedDatabase} was not found for ${cpanelUser}`);
    }

    const fileStub = selectedDatabases.length === 1
      ? selectedDatabases[0]
      : `${cpanelUser}-databases`;
    const filename = `${fileStub}.sql.gz`;
    const localArchive = path.join(tmpDir, filename);
    const mysqlArgs = [];

    if (fs.existsSync('/root/.my.cnf')) {
      mysqlArgs.push('--defaults-file=/root/.my.cnf');
    }

    const dumpScript = [
      'set -euo pipefail',
      `mysqldump ${mysqlArgs.join(' ')} --single-transaction --quick --databases ${selectedDatabases.map(shellQuote).join(' ')} | gzip -c > ${shellQuote(localArchive)}`
    ].join('; ');

    log(`Running mysqldump for ${cpanelUser}`, { databases: selectedDatabases });
    await runCommand('bash', ['-lc', dumpScript]);

    const stats = await fsp.stat(localArchive);
    const checksum = await sha256File(localArchive);
    const remoteDir = path.posix.join(config.remote_base_path, config.server_slug, cpanelUser);
    const remotePath = path.posix.join(remoteDir, filename);

    await ensureRemoteDir(config, remoteDir);
    log(`Uploading database backup to ${config.remote_host}:${remotePath}`);
    await rsyncFile(config, localArchive, remotePath);

    return {
      filename,
      filesize: stats.size,
      kind: 'db',
      remote_path: remotePath,
      checksum,
      notes: `Database backup for ${selectedDatabases.join(', ')} created by bovedix-agent on ${new Date().toISOString()}`
    };
  } finally {
    await cleanupDir(tmpDir);
  }
}

function inferDatabaseNameFromJob(job) {
  const payload = job.payload || {};
  if (payload.database_name) {
    return String(payload.database_name).trim();
  }

  const filename = String(payload.filename || '').trim();
  if (filename.endsWith('.sql.gz')) {
    return filename.slice(0, -'.sql.gz'.length);
  }

  return '';
}

async function ensureMysqlDatabase(databaseName) {
  const mysqlArgs = [];

  if (fs.existsSync('/root/.my.cnf')) {
    mysqlArgs.push('--defaults-file=/root/.my.cnf');
  }

  await runCommand('mysql', [
    ...mysqlArgs,
    '-NBe',
    `CREATE DATABASE IF NOT EXISTS \`${String(databaseName).replace(/`/g, '``')}\`;`
  ]);
}

async function runDatabaseRestoreJob(config, job) {
  const payload = job.payload || {};
  const cpanelUser = payload.cpanel_user || job.cpanel_user;
  const remotePath = String(payload.remote_path || '').trim();
  const databaseName = inferDatabaseNameFromJob(job);

  if (!cpanelUser) {
    throw new Error('Database restore job is missing cpanel_user');
  }

  if (!remotePath) {
    throw new Error('Database restore job is missing remote_path');
  }

  if (!databaseName) {
    throw new Error('Could not determine target database for restore');
  }

  const tmpDir = path.join(config.local_temp_dir, job.id);
  await cleanupDir(tmpDir);
  await ensureDir(tmpDir);

  try {
    const localArchive = path.join(tmpDir, path.basename(remotePath));
    const mysqlArgs = [];

    if (fs.existsSync('/root/.my.cnf')) {
      mysqlArgs.push('--defaults-file=/root/.my.cnf');
    }

    log(`Downloading database backup from ${config.remote_host}:${remotePath}`);
    await rsyncFromRemote(config, remotePath, localArchive);
    await ensureMysqlDatabase(databaseName);

    log(`Restoring database ${databaseName} for ${cpanelUser}`);
    const restoreScript = [
      'set -euo pipefail',
      `gunzip -c ${shellQuote(localArchive)} | mysql ${mysqlArgs.join(' ')} ${shellQuote(databaseName)}`
    ].join('; ');

    await runCommand('bash', ['-lc', restoreScript]);

    return {
      remote_path: remotePath,
      database_name: databaseName
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
      const backupKind = String(job.payload?.backup_kind || 'full').trim().toLowerCase();
      const backup = backupKind === 'db'
        ? await runDatabaseBackupJob(config, job)
        : backupKind === 'mail'
          ? await runMailBackupJob(config, job)
          : await runBackupJob(config, job);
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

    if (job.type === 'restore') {
      const backupKind = String(job.payload?.backup_kind || 'full').trim().toLowerCase();

      if (backupKind !== 'db') {
        throw new Error(`${backupKind || 'restore'} restore is not supported by the trial agent yet`);
      }

      const result = await runDatabaseRestoreJob(config, job);
      await api(config, `/api/agent/jobs/${job.id}/complete`, {
        method: 'POST',
        body: JSON.stringify({
          log: `Restore completed for ${job.cpanel_user}`,
          result
        })
      });
      log(`Completed restore job ${job.id}`);
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
