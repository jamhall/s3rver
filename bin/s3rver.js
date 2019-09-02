#!/usr/bin/env node
'use strict';

/* eslint-disable no-console */

const fs = require('fs-extra');
const program = require('commander');
const pkg = require('../package.json');
const S3rver = require('..');

function ensureDirectory(directory) {
  fs.ensureDirSync(directory);
  return directory;
}

// manually parse [config...] arguments for --create-bucket
function parseConfigureBucket(bucketName, memo = []) {
  let idx = 0;
  do {
    idx = program.rawArgs.indexOf('--configure-bucket', idx) + 1;
  } while (program.rawArgs[idx] !== bucketName);
  idx++;

  const bucketConfigs = [];
  while (
    idx < program.rawArgs.length &&
    !program.rawArgs[idx].startsWith('-')
  ) {
    bucketConfigs.push(program.rawArgs[idx++]);
  }
  memo.push({
    name: bucketName,
    configs: bucketConfigs.map(config => fs.readFileSync(config)),
  });
  return memo;
}

program
  .usage('-d <path> [options]')
  .option('-d, --directory <path>', 'Data directory', ensureDirectory)
  .option(
    '-a, --address <value>',
    'Hostname or IP to bind to',
    S3rver.defaultOptions.address,
  )
  .option(
    '-p, --port <n>',
    'Port of the http server',
    S3rver.defaultOptions.port,
  )
  .option('-s, --silent', 'Suppress log messages', S3rver.defaultOptions.silent)
  .option(
    '--key <path>',
    'Path to private key file for running with TLS',
    fs.readFileSync,
  )
  .option(
    '--cert <path>',
    'Path to certificate file for running with TLS',
    fs.readFileSync,
  )
  .option(
    '--service-endpoint <address>',
    'Overrides the AWS S3 service endpoint',
    S3rver.defaultOptions.serviceEndpoint,
  )
  .option(
    '--allow-mismatched-signatures',
    'Prevent SignatureDoesNotMatch errors for all well-formed signatures',
  )
  // NOTE: commander doesn't actually support options with multiple parts,
  // we must manually parse this option
  .option(
    '--configure-bucket <name> [configs...]',
    'Bucket name and configuration files for creating and configuring a bucket at startup',
    parseConfigureBucket,
  )
  .version(pkg.version, '-v, --version');

program.on('--help', () => {
  console.log('');
  console.log('Examples:');
  console.log('  $ s3rver -d /tmp/s3rver -a 0.0.0.0 -p 0');
  console.log(
    '  $ s3rver -d /tmp/s3rver --configure-bucket test-bucket ./cors.xml ./website.xml',
  );
});

try {
  program.parse(process.argv);
  program.configureBuckets = program.configureBucket;
  delete program.configureBucket;
} catch (err) {
  console.error('error: %s', err.message);
  process.exit(1);
}

if (program.directory === undefined) {
  console.error('error: data directory -d is required');
  process.exit(1);
}

new S3rver(program).run((err, { address, port } = {}) => {
  if (err) {
    console.error(err.message);
    process.exit(1);
  }
  console.log();
  console.log('S3rver listening on %s:%d', address, port);
});
