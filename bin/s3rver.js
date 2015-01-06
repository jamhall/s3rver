var S3rver = require('../lib');

var s3rver = new S3rver();
s3rver.setHostname('localhost')
  .setPort(4568)
  .setDirectory('/tmp/jamie')
  .setSilent(false)
  .run(function (err, host, port) {
    console.log('now listening on host %s and port %d', host, port);
  });
