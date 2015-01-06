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

describe('S3rver Tests', function () {
  var s3Client;
  var buckets = ['bucket1', 'bucket2', 'bucket3', 'bucket4', 'bucket5'];
  before(function (done) {
    var config = {
      accessKeyId: "123",
      secretAccessKey: "abc",
      endpoint: "localhost:3000",
      sslEnabled: false,
      s3ForcePathStyle: true
    };
    AWS.config.update(config);
    s3Client = new AWS.S3();
    s3Client.endpoint = new AWS.Endpoint(config.endpoint);
    /**
     * Make the temporary directory
     */
    fs.remove('/tmp/dummys3_root', function (err) {
      fs.mkdirs('/tmp/dummys3_root', function (err) {
        if (err) return console.error(err)
        done();
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
      console.log('Data', data.length);
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

  after(function (done) {
//    fs.remove('/tmp/dummys3_root', function (err) {
//      if (err) return console.error(err)
//      done();
//    });
    done();
  });

});
