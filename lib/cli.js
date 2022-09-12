'use strict';

const fs = require('fs');
const { Command } = require('commander');
const pkg = require('../package.json');
const S3rver = require('./s3rver');

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
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
    configs: bucketConfigs.map((config) => fs.readFileSync(config)),
  });
  return memo;
}

const program = new Command();
program
  .usage('-d <path> [options]')
  .requiredOption('-d, --directory <path>', 'Data directory', ensureDirectory)
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
    'Overrides the AWS service root for subdomain-style access',
    S3rver.defaultOptions.serviceEndpoint,
  )
  .option(
    '--allow-mismatched-signatures',
    'Prevent SignatureDoesNotMatch errors for all well-formed signatures',
  )
  .option('--no-vhost-buckets', 'Disables vhost-style access for all buckets')
  .option(
    '--configure-bucket <name> [configs...]',
    'Bucket name and configuration files for creating and configuring a bucket at startup',
    parseConfigureBucket,
  )
  .version(pkg.version, '-v, --version');

// NOTE: commander doesn't support repeated variadic options,
// we must manually parse this option
program.options.find((option) =>
  option.is('--configure-bucket'),
).variadic = false;

program.on('--help', () => {
  console.log('');
  console.log('Examples:');
  console.log('  $ s3rver -d /tmp/s3rver -a 0.0.0.0 -p 0');
  console.log(
    '  $ s3rver -d /tmp/s3rver --configure-bucket test-bucket ./cors.xml ./website.xml',
  );
});

program.action(async ({ configureBucket, ...opts }) => {
  opts.configureBuckets = configureBucket;
  const { address, port } = await new S3rver(opts).run();
  console.log();
  console.log('S3rver listening on %s:%d', address, port);
});

module.exports = program;
