var knox = require('knox');
var AWS = require('aws-sdk');
var async = require('async');
var should = require('should');
var fs = require('fs-extra');
var _ = require('lodash');
var moment = require('moment');
var Chance = require('chance');
var chance = new Chance();
var path = require('path');
var md5 = require('MD5');
var S3rver = require('../lib');
var util = require('util');

describe('S3rver Tests', function () {
  var s3Client;
  var buckets = ['bucket1', 'bucket2', 'bucket3', 'bucket4', 'bucket5'];
  before(function (done) {
    /**
     * Start the server
     */
    var s3rver = new S3rver();
    s3rver.setHostname('localhost')
      .setPort(4569)
      .setDirectory('/tmp/s3rver_test_directory')
      .setSilent(true)
      .run(function (err, hostname, port, directory) {
        if (err) {
          return done('Error starting server', err);
        }
        var config = {
          accessKeyId: '123',
          secretAccessKey: 'abc',
          endpoint: util.format('%s:%d', hostname, port),
          sslEnabled: false,
          s3ForcePathStyle: true
        };
        AWS.config.update(config);
        s3Client = new AWS.S3();
        s3Client.endpoint = new AWS.Endpoint(config.endpoint);
        /**
         * Remove if exists and recreate the temporary directory
         */
        fs.remove(directory, function (err) {
          if (err) {
            return done(err);
          }
          fs.mkdirs(directory, function (err) {
            if (err) return done(err);
            done();
          });
        });
      });
  });

  it('should create five buckets', function (done) {
    async.eachSeries(buckets, function (bucket, callback) {
      s3Client.createBucket({Bucket: bucket}, function (err) {
        if (err) {
          return callback(err);
        }
        callback(null);
      });
    }, function (err) {
      if (err) {
        return done(err);
      }
      done();
    });
  });

  it('should fetch fetch five buckets', function (done) {
    s3Client.listBuckets(function (err, buckets) {
      if (err) return done(err);
      buckets.Buckets.length.should.equal(5);
      _.forEach(buckets.Buckets, function (bucket) {
        bucket.Name.should.be.ok;
        moment(bucket.CreationDate).isValid().should.equal(true);
      });
      done();
    });
  });

  it('should fail to create a bucket because of invalid name', function (done) {
    s3Client.createBucket({Bucket: '-$%!nvalid'}, function (err) {
      err.statusCode.should.equal(400);
      err.code.should.equal('InvalidBucketName');
      should.exist(err);
      done();
    });
  });

  it('should fail to create a bucket because name is too long', function (done) {
    s3Client.createBucket({Bucket: chance.string({length: 64, pool: 'abcd'})}, function (err) {
      err.statusCode.should.equal(400);
      err.code.should.equal('InvalidBucketName');
      should.exist(err);
      done();
    });
  });

  it('should fail to create a bucket because name is too short', function (done) {
    s3Client.createBucket({Bucket: 'ab' }, function (err) {
      err.statusCode.should.equal(400);
      err.code.should.equal('InvalidBucketName');
      should.exist(err);
      done();
    });
  });

  it('should delete a bucket', function (done) {
    s3Client.deleteBucket({ Bucket: buckets[4] }, function (err) {
      if (err) return done(err);
      return done();
    });
  });

  it('should not fetch the deleted bucket', function (done) {
    s3Client.listObjects({ Bucket: buckets[4] }, function (err) {
      err.code.should.equal('NoSuchBucket');
      err.statusCode.should.equal(404);
      done();
    });
  });

  it('should list no objects for a bucket', function (done) {
    s3Client.listObjects({ Bucket: buckets[3] }, function (err, objects) {
      if (err) {
        return done(err);
      }
      objects.Contents.length.should.equal(0);
      done();
    });
  });

  it('should store a text object in a bucket', function (done) {
    var params = {Bucket: buckets[0], Key: 'text', Body: 'Hello!'};
    s3Client.putObject(params, function (err, data) {
      /[a-fA-F0-9]{32}/.test(data.ETag).should.equal(true);
      if (err) {
        return done(err);
      }
      done();
    });
  });

  it('should store an image in a bucket', function (done) {
    var file = path.join(__dirname, 'resources/image.jpg');
    fs.readFile(file, function (err, data) {
      if (err) {
        return done(err);
      }
      var params = {Bucket: buckets[0], Key: 'image', Body: new Buffer(data), ContentType: 'image/jpeg', ContentLength: data.length };
      s3Client.putObject(params, function (err, data) {
        /[a-fA-F0-9]{32}/.test(data.ETag).should.equal(true);
        if (err) {
          return done(err);
        }
        done();
      });
    });
  });

  it('should store a large buffer in a bucket', function (done) {
    // 20M
    var b = new Buffer(20000000);
    var params = {Bucket: buckets[0], Key: 'large', Body: b };
    s3Client.putObject(params, function (err, data) {
      if (err) {
        return done(err);
      }
      /[a-fA-F0-9]{32}/.test(data.ETag).should.equal(true);
      done();
    });
  });

  it('should get an image from a bucket', function (done) {
    var file = path.join(__dirname, 'resources/image.jpg');
    fs.readFile(file, function (err, data) {
      s3Client.getObject({ Bucket: buckets[0], Key: 'image'}, function (err, object) {
        if (err) {
          return done(err);
        }
        object.ETag.should.equal(md5(data));
        object.ContentLength.should.equal(data.length.toString());
        object.ContentType.should.equal('image/jpeg');
        done();
      });
    });
  });

  it('should get image metadata from a bucket using HEAD method', function (done) {
    var file = path.join(__dirname, 'resources/image.jpg');
    fs.readFile(file, function (err, data) {
      s3Client.headObject({ Bucket: buckets[0], Key: 'image'}, function (err, object) {
        if (err) {
          return done(err);
        }
        object.ETag.should.equal(md5(data));
        object.ContentLength.should.equal(data.length.toString());
        object.ContentType.should.equal('image/jpeg');
        done();
      });
    });
  });

  it('should delete an image from a bucket', function (done) {
    s3Client.deleteObject({ Bucket: buckets[0], Key: 'image'}, function (err) {
      if (err) {
        return done(err);
      }
      done();
    });
  });

  it('should not find an image from a bucket', function (done) {
    s3Client.getObject({ Bucket: buckets[0], Key: 'image'}, function (err) {
      err.code.should.equal('NoSuchKey');
      err.statusCode.should.equal(404);
      done();
    });
  });

  it('should fail to delete a bucket because it is not empty', function (done) {
    s3Client.deleteBucket({ Bucket: buckets[0] }, function (err, data) {
      err.code.should.equal('BucketNotEmpty');
      err.statusCode.should.equal(409);
      done();
    });
  });

  it('should upload a text file to a multi directory path', function (done) {
    var params = {Bucket: buckets[0], Key: 'multi/directory/path/text', Body: 'Hello!'};
    s3Client.putObject(params, function (err, data) {
      /[a-fA-F0-9]{32}/.test(data.ETag).should.equal(true);
      if (err) {
        return done(err);
      }
      done();
    });
  });

  it('should find a text file in a multi directory path', function (done) {
    s3Client.getObject({ Bucket: buckets[0], Key: 'multi/directory/path/text'}, function (err, object) {
      if (err) {
        return done(err);
      }
      object.ETag.should.equal(md5('Hello!'));
      object.ContentLength.should.equal('6');
      object.ContentType.should.equal('application/octet-stream');
      done();
    });
  });

  it('should list objects in a bucket', function (done) {
    // Create some test objects
    var testObjects = ['akey1', 'akey2', 'akey3', 'key/key1', 'key1', 'key2', 'key3'];
    async.eachSeries(testObjects, function (testObject, callback) {
      var params = {Bucket: buckets[1], Key: testObject, Body: 'Hello!'};
      s3Client.putObject(params, function (err, object) {
        /[a-fA-F0-9]{32}/.test(object.ETag).should.equal(true);
        if (err) {
          return callback(err);
        }
        callback();
      });
    }, function (err) {
      if (err) {
        return done(err);
      }
      s3Client.listObjects({ 'Bucket': buckets[1] }, function (err, objects) {
        if (err) {
          return done(err);
        }
        should(objects.Contents.length).equal(testObjects.length);
        done();
      });
    });
  });

  it('should list objects in a bucket filtered by a prefix', function (done) {
    // Create some test objects
    s3Client.listObjects({ 'Bucket': buckets[1], Prefix: 'key' }, function (err, objects) {
      if (err) {
        return done(err);
      }
      should(objects.Contents.length).equal(4);
      should(_.find(objects.Contents, { 'Key': 'key1' })).be.ok;
      should(_.find(objects.Contents, { 'Key': 'key2' })).be.ok;
      should(_.find(objects.Contents, { 'Key': 'key3' })).be.ok;
      should(_.find(objects.Contents, { 'Key': 'key/key1' })).be.ok;
      done();
    });
  });

  it('should list objects in a bucket filtered by a marker', function (done) {

    // Create some test objects
    s3Client.listObjects({ 'Bucket': buckets[1], Marker: 'akey3' }, function (err, objects) {
      if (err) {
        return done(err);
      }
      should(objects.Contents.length).equal(5);
      done();
    });
  });

  it('should list objects in a bucket filtered by a marker and prefix', function (done) {
    // Create some test objects
    s3Client.listObjects({ 'Bucket': buckets[1], Prefix: 'akey', Marker: 'akey2' }, function (err, objects) {
      if (err) {
        return done(err);
      }
      should(objects.Contents.length).equal(2);
      done();
    });
  });

  it('should list no objects because of invalid prefix', function (done) {
    // Create some test objects
    s3Client.listObjects({ 'Bucket': buckets[1], Prefix: 'myinvalidprefix' }, function (err, objects) {
      if (err) {
        return done(err);
      }
      should(objects.Contents.length).equal(0);
      done();
    });
  });

  it('should list no objects because of invalid marker', function (done) {
    // Create some test objects
    s3Client.listObjects({ 'Bucket': buckets[1], Marker: 'myinvalidmarker' }, function (err, objects) {
      if (err) {
        return done(err);
      }
      should(objects.Contents.length).equal(0);
      done();
    });
  });

  it('should generate a few thousand small objects', function (done) {
    var testObjects = [];
    for (var i = 1; i <= 2000; i++) {
      testObjects.push({Bucket: buckets[2], Key: 'key' + i, Body: 'Hello!'});
    }
    async.eachSeries(testObjects, function (testObject, callback) {
      s3Client.putObject(testObject, function (err, object) {
        /[a-fA-F0-9]{32}/.test(object.ETag).should.equal(true);
        if (err) {
          return callback(err);
        }
        callback();
      });
    }, function (err) {
      if (err) {
        return done(err);
      }
      done();
    });
  });

  it('should return one thousand small objects', function (done) {
    s3Client.listObjects({ 'Bucket': buckets[2] }, function (err, objects) {
      if (err) {
        return done(err);
      }
      should(objects.Contents.length).equal(1000);
      done();
    });
  });

  it('should return 500 small objects', function (done) {
    s3Client.listObjects({ 'Bucket': buckets[2], MaxKeys: 500}, function (err, objects) {
      if (err) {
        return done(err);
      }
      should(objects.Contents.length).equal(500);
      done();
    });
  });

  it('should delete 500 small objects', function (done) {
    var testObjects = [];
    for (var i = 1; i <= 500; i++) {
      testObjects.push({Bucket: buckets[2], Key: 'key' + i });
    }
    async.eachSeries(testObjects, function (testObject, callback) {
      s3Client.deleteObject(testObject, function (err) {
        if (err) {
          return callback(err);
        }
        callback();
      });
    }, function (err) {
      if (err) {
        return done(err);
      }
      done();
    });
  });
});
