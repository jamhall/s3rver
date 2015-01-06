S3rver

==================

S3rver is a NodeJs port of the excellent [FakeS3](https://github.com/jubos/fake-s3) server.

S3rver is a lightweight server that responds to the same calls Amazon S3 responds to. It is extremely useful for testing of S3 in a sandbox environment without actually making calls to Amazon.

The goal of Fake S3 is to minimise runtime dependencies and be more of a development tool to test S3 calls in your code rather than a production server looking to duplicate S3 functionality.

It is currently under active development. Tests are also currently being written.

Currently working

- [x] List buckets
- [x] Create bucket
- [x] Delete bucket
- [x] List objects for bucket (including prefix but not yet delimiter or max keys)
- [x] Store object for bucket (mutipart)
- [x] Delete object for bucket
- [x] Get object (including HEAD, If-Modified-Since, If-None-Match)

Not working

- [ ] Copy object
- [ ] Rate limiting
- [ ] Put object stream
