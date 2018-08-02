"use strict";

const AWS = require("aws-sdk");
const chai = require("chai");
const chaiAsPromised = require("chai-as-promised");
const fs = require("fs-extra");
const { find, times } = require("lodash");
const md5 = require("md5");
const moment = require("moment");
const os = require("os");
const path = require("path");
const promiseLimit = require("promise-limit");
const request = require("request-promise-native");
const { take } = require("rxjs/operators");

const { thunkToPromise } = require("../lib/utils");

const S3rver = require("..");

const { expect } = chai;
chai.use(chaiAsPromised);

const tmpDir = path.join(os.tmpdir(), "s3rver_test");
S3rver.defaultOptions.directory = tmpDir;

/**
 * Remove if exists and recreate the temporary directory
 *
 * Be aware of https://github.com/isaacs/rimraf/issues/25
 * Buckets can fail to delete on Windows likely due to a bug/shortcoming in Node.js
 */
function resetTmpDir() {
  try {
    fs.removeSync(tmpDir);
    // eslint-disable-next-line no-empty
  } catch (err) {}
  fs.ensureDirSync(tmpDir);
}

function generateTestObjects(s3Client, bucket, amount) {
  const objects = times(amount, i => ({
    Bucket: bucket,
    Key: "key" + i,
    Body: "Hello!"
  }));

  return promiseLimit(100).map(objects, object =>
    s3Client.putObject(object).promise()
  );
}

describe("S3rver Tests", function() {
  const buckets = [
    "bucket1",
    "bucket2",
    "bucket3",
    "bucket4",
    "bucket5",
    "bucket6"
  ];
  let server;
  let s3Client;

  beforeEach("Reset buckets", resetTmpDir);
  beforeEach("Start server and create buckets", function*() {
    const [, port] = yield thunkToPromise(done => {
      server = new S3rver({
        port: 4569,
        silent: true
      }).run(done);
    });

    s3Client = new AWS.S3({
      accessKeyId: "123",
      secretAccessKey: "abc",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    // Create 6 buckets
    yield Promise.all(
      buckets.map(bucket =>
        s3Client
          .createBucket({ Bucket: bucket })
          .promise()
          .catch(err => {
            if (err.code !== "BucketAlreadyExists") throw err;
          })
      )
    );
  });

  afterEach("Close server", function(done) {
    server.close(done);
  });

  it("should fetch fetch six buckets", function*() {
    const buckets = yield s3Client.listBuckets().promise();
    expect(buckets.Buckets).to.have.lengthOf(6);
    for (const bucket of buckets.Buckets) {
      expect(bucket.Name).to.exist;
      expect(moment(bucket.CreationDate).isValid()).to.be.true;
    }
  });

  it("should create a bucket with valid domain-style name", function*() {
    yield s3Client.createBucket({ Bucket: "a-test.example.com" }).promise();
  });

  it("should fail to create a bucket because of invalid name", function*() {
    let error;
    try {
      yield s3Client.createBucket({ Bucket: "-$%!nvalid" }).promise();
    } catch (err) {
      error = err;
      expect(err.statusCode).to.equal(400);
      expect(err.code).to.equal("InvalidBucketName");
    }
    expect(error).to.exist;
  });

  it("should fail to create a bucket because of invalid domain-style name", function*() {
    let error;
    try {
      yield s3Client.createBucket({ Bucket: ".example.com" }).promise();
    } catch (err) {
      error = err;
      expect(err.statusCode).to.equal(400);
      expect(err.code).to.equal("InvalidBucketName");
    }
    expect(error).to.exist;
  });

  it("should fail to create a bucket because name is too long", function*() {
    let error;
    try {
      yield s3Client.createBucket({ Bucket: "abcd".repeat(16) }).promise();
    } catch (err) {
      error = err;
      expect(err.statusCode).to.equal(400);
      expect(err.code).to.equal("InvalidBucketName");
    }
    expect(error).to.exist;
  });

  it("should fail to create a bucket because name is too short", function*() {
    let error;
    try {
      yield s3Client.createBucket({ Bucket: "ab" }).promise();
    } catch (err) {
      error = err;
      expect(err.statusCode).to.equal(400);
      expect(err.code).to.equal("InvalidBucketName");
    }
    expect(error).to.exist;
  });

  it("should delete a bucket", function*() {
    yield s3Client.deleteBucket({ Bucket: buckets[4] }).promise();
  });

  it("should not fetch the deleted bucket", function*() {
    let error;
    yield s3Client.deleteBucket({ Bucket: buckets[4] }).promise();
    try {
      yield s3Client.listObjects({ Bucket: buckets[4] }).promise();
    } catch (err) {
      error = err;
      expect(err.code).to.equal("NoSuchBucket");
      expect(err.statusCode).to.equal(404);
    }
    expect(error).to.exist;
  });

  it("should list no objects for a bucket", function*() {
    yield s3Client.listObjects({ Bucket: buckets[3] }).promise();
    const objects = yield s3Client
      .listObjects({ Bucket: buckets[3] })
      .promise();
    expect(objects.Contents).to.have.lengthOf(0);
  });

  it("should store a text object in a bucket", function*() {
    const data = yield s3Client
      .putObject({ Bucket: buckets[0], Key: "text", Body: "Hello!" })
      .promise();
    expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
  });

  it("should store a text object with no content type and retrieve it", function*() {
    const res = yield request({
      method: "PUT",
      baseUrl: s3Client.config.endpoint,
      url: `/${buckets[0]}/text`,
      body: "Hello!",
      resolveWithFullResponse: true
    });
    expect(res.statusCode).to.equal(200);
    const data = yield s3Client
      .getObject({ Bucket: buckets[0], Key: "text" })
      .promise();
    expect(data.ContentType).to.equal("binary/octet-stream");
  });

  it("should trigger an event with a valid message structure", function*() {
    const eventPromise = server.s3Event.pipe(take(1)).toPromise();
    const body = "Hello!";
    yield s3Client
      .putObject({ Bucket: buckets[0], Key: "testPutKey", Body: body })
      .promise();
    const event = yield eventPromise;
    const iso8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    expect(event.Records[0].eventTime).to.match(iso8601);
    expect(new Date(event.Records[0].eventTime)).to.not.satisfy(isNaN);
  });

  it("should trigger a Put event", function*() {
    const eventPromise = server.s3Event.pipe(take(1)).toPromise();
    const body = "Hello!";
    yield s3Client
      .putObject({ Bucket: buckets[0], Key: "testPutKey", Body: body })
      .promise();
    const event = yield eventPromise;
    expect(event.Records[0].eventName).to.equal("ObjectCreated:Put");
    expect(event.Records[0].s3.bucket.name).to.equal(buckets[0]);
    expect(event.Records[0].s3.object).to.contain({
      key: "testPutKey",
      size: body.length,
      eTag: md5(body)
    });
  });

  it("should trigger a Copy event", function*() {
    const body = "Hello!";
    yield s3Client
      .putObject({ Bucket: buckets[0], Key: "testPut", Body: body })
      .promise();
    const eventPromise = server.s3Event.pipe(take(1)).toPromise();
    yield s3Client
      .copyObject({
        Bucket: buckets[4],
        Key: "testCopy",
        CopySource: "/" + buckets[0] + "/testPut"
      })
      .promise();
    const event = yield eventPromise;
    expect(event.Records[0].eventName).to.equal("ObjectCreated:Copy");
    expect(event.Records[0].s3.bucket.name).to.equal(buckets[4]);
    expect(event.Records[0].s3.object).to.contain({
      key: "testCopy",
      size: body.length
    });
  });

  it("should trigger a Delete event", function*() {
    const body = "Hello!";
    yield s3Client
      .putObject({
        Bucket: buckets[0],
        Key: "testDelete",
        Body: body
      })
      .promise();
    const eventPromise = server.s3Event.pipe(take(1)).toPromise();
    yield s3Client
      .deleteObject({ Bucket: buckets[0], Key: "testDelete" })
      .promise();
    const event = yield eventPromise;
    expect(event.Records[0].eventName).to.equal("ObjectRemoved:Delete");
    expect(event.Records[0].s3.bucket.name).to.equal(buckets[0]);
    expect(event.Records[0].s3.object).to.contain({
      key: "testDelete"
    });
  });

  it("should store a text object with some custom metadata", function*() {
    const data = yield s3Client
      .putObject({
        Bucket: buckets[0],
        Key: "textmetadata",
        Body: "Hello!",
        Metadata: {
          someKey: "value"
        }
      })
      .promise();
    expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
  });

  it("should return a text object with some custom metadata", function*() {
    const data = yield s3Client
      .putObject({
        Bucket: buckets[0],
        Key: "textmetadata",
        Body: "Hello!",
        Metadata: {
          someKey: "value"
        }
      })
      .promise();
    expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
    const object = yield s3Client
      .getObject({ Bucket: buckets[0], Key: "textmetadata" })
      .promise();
    expect(object.Metadata.somekey).to.equal("value");
  });

  it("should store an image in a bucket", function*() {
    const file = path.join(__dirname, "resources/image0.jpg");
    const data = yield s3Client
      .putObject({
        Bucket: buckets[0],
        Key: "image",
        Body: yield fs.readFile(file),
        ContentType: "image/jpeg"
      })
      .promise();
    expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
  });

  it("should store a gzip encoded file in bucket", function*() {
    const file = path.join(__dirname, "resources/jquery.js.gz");

    const params = {
      Bucket: buckets[0],
      Key: "jquery",
      Body: yield fs.readFile(file),
      ContentType: "application/javascript",
      ContentEncoding: "gzip"
    };

    yield s3Client.putObject(params).promise();
    const object = yield s3Client
      .getObject({ Bucket: buckets[0], Key: "jquery" })
      .promise();
    expect(object.ContentEncoding).to.equal("gzip");
    expect(object.ContentType).to.equal("application/javascript");
  });

  it("should copy an image object into another bucket", function*() {
    const srcKey = "image";
    const destKey = "image/jamie";

    const file = path.join(__dirname, "resources/image0.jpg");
    const data = yield s3Client
      .putObject({
        Bucket: buckets[0],
        Key: srcKey,
        Body: yield fs.readFile(file),
        ContentType: "image/jpeg"
      })
      .promise();
    expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
    const copyResult = yield s3Client
      .copyObject({
        Bucket: buckets[3],
        Key: destKey,
        CopySource: "/" + buckets[0] + "/" + srcKey
      })
      .promise();
    expect(copyResult.ETag).to.equal(data.ETag);
    expect(moment(copyResult.LastModified).isValid()).to.be.true;
  });

  it("should copy an image object into another bucket including its metadata", function*() {
    const srcKey = "image";
    const destKey = "image/jamie";

    const file = path.join(__dirname, "resources/image0.jpg");
    const data = yield s3Client
      .putObject({
        Bucket: buckets[0],
        Key: srcKey,
        Body: yield fs.readFile(file),
        ContentType: "image/jpeg",
        Metadata: {
          someKey: "value"
        }
      })
      .promise();
    expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
    yield s3Client
      .copyObject({
        Bucket: buckets[3],
        Key: destKey,
        // MetadataDirective is implied to be COPY
        CopySource: "/" + buckets[0] + "/" + srcKey
      })
      .promise();
    const object = yield s3Client
      .getObject({ Bucket: buckets[3], Key: destKey })
      .promise();
    expect(object.Metadata).to.have.property("somekey", "value");
    expect(object.ContentType).to.equal("image/jpeg");
  });

  it("should copy an object using spaces/unicode chars in keys", function*() {
    const srcKey = "awesome 驚くばかり.jpg";
    const destKey = "new 新しい.jpg";

    const file = path.join(__dirname, "resources/image0.jpg");
    const data = yield s3Client
      .putObject({
        Bucket: buckets[0],
        Key: srcKey,
        Body: yield fs.readFile(file),
        ContentType: "image/jpeg"
      })
      .promise();
    expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
    const copyResult = yield s3Client
      .copyObject({
        Bucket: buckets[0],
        Key: destKey,
        CopySource: "/" + buckets[0] + "/" + encodeURI(srcKey)
      })
      .promise();
    expect(copyResult.ETag).to.equal(data.ETag);
    expect(moment(copyResult.LastModified).isValid()).to.be.true;
  });

  it("should update the metadata of an image object", function*() {
    const srcKey = "image";
    const destKey = "image/jamie";

    const file = path.join(__dirname, "resources/image0.jpg");
    const data = yield s3Client
      .putObject({
        Bucket: buckets[0],
        Key: srcKey,
        Body: yield fs.readFile(file),
        ContentType: "image/jpeg"
      })
      .promise();
    expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
    yield s3Client
      .copyObject({
        Bucket: buckets[3],
        Key: destKey,
        CopySource: "/" + buckets[0] + "/" + srcKey,
        MetadataDirective: "REPLACE",
        Metadata: {
          someKey: "value"
        }
      })
      .promise();
    const object = yield s3Client
      .getObject({ Bucket: buckets[3], Key: destKey })
      .promise();
    expect(object.Metadata).to.have.property("somekey", "value");
    expect(object.ContentType).to.equal("application/octet-stream");
  });

  it("should copy an image object into another bucket and update its metadata", function*() {
    const srcKey = "image";
    const destKey = "image/jamie";

    const file = path.join(__dirname, "resources/image0.jpg");
    yield s3Client
      .putObject({
        Bucket: buckets[0],
        Key: srcKey,
        Body: yield fs.readFile(file),
        ContentType: "image/jpeg"
      })
      .promise();
    yield s3Client
      .copyObject({
        Bucket: buckets[3],
        Key: destKey,
        CopySource: "/" + buckets[0] + "/" + srcKey,
        MetadataDirective: "REPLACE",
        Metadata: {
          someKey: "value"
        }
      })
      .promise();
    const object = yield s3Client
      .getObject({ Bucket: buckets[3], Key: destKey })
      .promise();
    expect(object.Metadata.somekey).to.equal("value");
    expect(object.ContentType).to.equal("application/octet-stream");
  });

  it("should fail to copy an image object because the object does not exist", function*() {
    let error;
    try {
      yield s3Client
        .copyObject({
          Bucket: buckets[3],
          Key: "image/jamie",
          CopySource: "/" + buckets[0] + "/doesnotexist"
        })
        .promise();
    } catch (err) {
      error = err;
      expect(err.code).to.equal("NoSuchKey");
      expect(err.statusCode).to.equal(404);
    }
    expect(error).to.exist;
  });

  it("should fail to copy an image object because the source bucket does not exist", function*() {
    let error;
    try {
      yield s3Client
        .copyObject({
          Bucket: buckets[3],
          Key: "image/jamie",
          CopySource: "/falsebucket/doesnotexist"
        })
        .promise();
    } catch (err) {
      error = err;
      expect(err.code).to.equal("NoSuchBucket");
      expect(err.statusCode).to.equal(404);
    }
    expect(error).to.exist;
  });

  it("should fail to update the metadata of an image object when no REPLACE MetadataDirective is specified", function*() {
    const key = "image";

    const file = path.join(__dirname, "resources/image0.jpg");
    const data = yield s3Client
      .putObject({
        Bucket: buckets[0],
        Key: key,
        Body: yield fs.readFile(file),
        ContentType: "image/jpeg"
      })
      .promise();
    expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
    let error;
    try {
      yield s3Client
        .copyObject({
          Bucket: buckets[0],
          Key: key,
          CopySource: "/" + buckets[0] + "/" + key,
          Metadata: {
            someKey: "value"
          }
        })
        .promise();
    } catch (err) {
      error = err;
      expect(err.statusCode).to.equal(400);
    }
    expect(error).to.exist;
  });

  it("should store a large buffer in a bucket", function*() {
    const data = yield s3Client
      .putObject({
        Bucket: buckets[0],
        Key: "large",
        Body: Buffer.alloc(20 * Math.pow(1024, 2))
      })
      .promise();
    expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
  });

  it("should get an image from a bucket", function*() {
    const file = path.join(__dirname, "resources/image0.jpg");
    const data = yield fs.readFile(file);
    yield s3Client
      .putObject({
        Bucket: buckets[0],
        Key: "image",
        Body: data,
        ContentType: "image/jpeg"
      })
      .promise();
    const object = yield s3Client
      .getObject({ Bucket: buckets[0], Key: "image" })
      .promise();
    expect(object.ETag).to.equal(JSON.stringify(md5(data)));
    expect(object.ContentLength).to.equal(data.length);
    expect(object.ContentType).to.equal("image/jpeg");
  });

  it("should get partial image from a bucket with a range request", function*() {
    const file = path.join(__dirname, "resources/image0.jpg");
    yield s3Client
      .putObject({
        Bucket: buckets[0],
        Key: "image",
        Body: yield fs.readFile(file),
        ContentType: "image/jpeg"
      })
      .promise();
    const url = s3Client.getSignedUrl("getObject", {
      Bucket: buckets[0],
      Key: "image"
    });
    const res = yield request({
      url,
      headers: { range: "bytes=0-99" },
      resolveWithFullResponse: true
    });
    expect(res.statusCode).to.equal(206);
    expect(res.headers).to.have.property("content-range");
    expect(res.headers).to.have.property("accept-ranges");
    expect(res.headers).to.have.property("content-length", "100");
  });

  it("should get image metadata from a bucket using HEAD method", function*() {
    const file = path.join(__dirname, "resources/image0.jpg");
    const fileContent = yield fs.readFile(file);
    yield s3Client
      .putObject({
        Bucket: buckets[0],
        Key: "image",
        Body: fileContent,
        ContentType: "image/jpeg",
        ContentLength: fileContent.length
      })
      .promise();
    const object = yield s3Client
      .headObject({ Bucket: buckets[0], Key: "image" })
      .promise();
    expect(object.ETag).to.equal(JSON.stringify(md5(fileContent)));
    expect(object.ContentLength).to.equal(fileContent.length);
    expect(object.ContentType).to.equal("image/jpeg");
  });

  it("should store a different image and update the previous image", function*() {
    const files = [
      path.join(__dirname, "resources/image0.jpg"),
      path.join(__dirname, "resources/image1.jpg")
    ];

    // Get object from store
    yield s3Client
      .putObject({
        Bucket: buckets[0],
        Key: "image",
        Body: yield fs.readFile(files[0]),
        ContentType: "image/jpeg"
      })
      .promise();
    const object = yield s3Client
      .getObject({ Bucket: buckets[0], Key: "image" })
      .promise();

    // Store different object
    const storedObject = yield s3Client
      .putObject({
        Bucket: buckets[0],
        Key: "image",
        Body: yield fs.readFile(files[1]),
        ContentType: "image/jpeg"
      })
      .promise();
    expect(storedObject.ETag).to.not.equal(object.ETag);

    // Get object again and do some comparisons
    const newObject = yield s3Client
      .getObject({ Bucket: buckets[0], Key: "image" })
      .promise();
    expect(newObject.LastModified).to.not.equal(object.LastModified);
    expect(newObject.ContentLength).to.not.equal(object.ContentLength);
  });

  it("should get an objects acl from a bucket", function*() {
    const object = yield s3Client
      .getObjectAcl({ Bucket: buckets[0], Key: "image0" })
      .promise();
    expect(object.Owner.DisplayName).to.equal("S3rver");
  });

  it("should delete an image from a bucket", function*() {
    yield s3Client
      .putObject({ Bucket: buckets[0], Key: "large", Body: Buffer.alloc(10) })
      .promise();
    yield s3Client.deleteObject({ Bucket: buckets[0], Key: "large" }).promise();
  });

  it("should not find an image from a bucket", function*() {
    let error;
    try {
      yield s3Client.getObject({ Bucket: buckets[0], Key: "image" }).promise();
    } catch (err) {
      error = err;
      expect(err.code).to.equal("NoSuchKey");
      expect(err.statusCode).to.equal(404);
    }
    expect(error).to.exist;
  });

  it("should not fail to delete a nonexistent object from a bucket", function*() {
    yield s3Client
      .deleteObject({ Bucket: buckets[0], Key: "doesnotexist" })
      .promise();
  });

  it("should fail to delete a bucket because it is not empty", function*() {
    let error;
    yield generateTestObjects(s3Client, buckets[0], 20);
    try {
      yield s3Client.deleteBucket({ Bucket: buckets[0] }).promise();
    } catch (err) {
      error = err;
      expect(err.code).to.equal("BucketNotEmpty");
      expect(err.statusCode).to.equal(409);
    }
    expect(error).to.exist;
  });

  it("should upload a text file to a multi directory path", function*() {
    const data = yield s3Client
      .putObject({
        Bucket: buckets[0],
        Key: "multi/directory/path/text",
        Body: "Hello!"
      })
      .promise();
    expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
  });

  it("should upload a managed upload <=5MB", function*() {
    const data = yield s3Client
      .upload({
        Bucket: buckets[0],
        Key: "multi/directory/path/multipart",
        Body: Buffer.alloc(2 * Math.pow(1024, 2)) // 2MB
      })
      .promise();
    expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
  });

  it("should upload a managed upload >5MB (multipart upload)", function*() {
    const data = yield s3Client
      .upload({
        Bucket: buckets[0],
        Key: "multi/directory/path/multipart",
        Body: Buffer.alloc(20 * Math.pow(1024, 2)) // 20MB
      })
      .promise();
    expect(data.ETag).to.match(/"[a-fA-F0-9]{32}"/);
  });

  it("should find a text file in a multi directory path", function*() {
    yield s3Client
      .putObject({
        Bucket: buckets[0],
        Key: "multi/directory/path/text",
        Body: "Hello!"
      })
      .promise();
    const object = yield s3Client
      .getObject({ Bucket: buckets[0], Key: "multi/directory/path/text" })
      .promise();
    expect(object.ETag).to.equal(JSON.stringify(md5("Hello!")));
    expect(object.ContentLength).to.equal(6);
    expect(object.ContentType).to.equal("application/octet-stream");
  });

  it("should list objects in a bucket", function*() {
    const testObjects = [
      "akey1",
      "akey2",
      "akey3",
      "key/key1",
      "key1",
      "key2",
      "key3"
    ];
    // Create some test objects
    yield Promise.all(
      testObjects.map(key =>
        s3Client
          .putObject({ Bucket: buckets[1], Key: key, Body: "Hello!" })
          .promise()
      )
    );
    const data = yield s3Client.listObjects({ Bucket: buckets[1] }).promise();
    expect(data.Name).to.equal(buckets[1]);
    expect(data.Contents).to.have.lengthOf(testObjects.length);
    expect(data.IsTruncated).to.be.false;
  });

  it("should list objects in a bucket filtered by a prefix", function*() {
    const testObjects = [
      "akey1",
      "akey2",
      "akey3",
      "key/key1",
      "key1",
      "key2",
      "key3"
    ];
    // Create some test objects
    yield Promise.all(
      testObjects.map(key =>
        s3Client
          .putObject({ Bucket: buckets[1], Key: key, Body: "Hello!" })
          .promise()
      )
    );

    const data = yield s3Client
      .listObjects({ Bucket: buckets[1], Prefix: "key" })
      .promise();
    expect(data.Contents).to.have.lengthOf(4);
    expect(find(data.Contents, { Key: "akey1" })).to.not.exist;
    expect(find(data.Contents, { Key: "akey2" })).to.not.exist;
    expect(find(data.Contents, { Key: "akey3" })).to.not.exist;
  });

  it("should list objects in a bucket filtered by a prefix [v2]", function*() {
    const testObjects = [
      "akey1",
      "akey2",
      "akey3",
      "key/key1",
      "key1",
      "key2",
      "key3"
    ];
    yield Promise.all(
      testObjects.map(key =>
        s3Client
          .putObject({ Bucket: buckets[1], Key: key, Body: "Hello!" })
          .promise()
      )
    );
    const data = yield s3Client
      .listObjectsV2({ Bucket: buckets[1], Prefix: "key" })
      .promise();
    expect(data.Contents).to.have.lengthOf(4);
    expect(find(data.Contents, { Key: "akey1" })).to.not.exist;
    expect(find(data.Contents, { Key: "akey2" })).to.not.exist;
    expect(find(data.Contents, { Key: "akey3" })).to.not.exist;
  });

  it("should list objects in a bucket filtered by a marker", function*() {
    const testObjects = [
      "akey1",
      "akey2",
      "akey3",
      "key/key1",
      "key1",
      "key2",
      "key3"
    ];
    yield Promise.all(
      testObjects.map(key =>
        s3Client
          .putObject({ Bucket: buckets[1], Key: key, Body: "Hello!" })
          .promise()
      )
    );
    const data = yield s3Client
      .listObjects({
        Bucket: buckets[1],
        Marker: "akey3"
      })
      .promise();
    expect(data.Contents).to.have.lengthOf(4);
  });

  it("should list objects in a bucket filtered by a marker and prefix", function*() {
    const testObjects = [
      "akey1",
      "akey2",
      "akey3",
      "key/key1",
      "key1",
      "key2",
      "key3"
    ];
    yield Promise.all(
      testObjects.map(key =>
        s3Client
          .putObject({ Bucket: buckets[1], Key: key, Body: "Hello!" })
          .promise()
      )
    );
    const data = yield s3Client
      .listObjects({ Bucket: buckets[1], Prefix: "akey", Marker: "akey2" })
      .promise();
    expect(data.Contents).to.have.lengthOf(1);
  });

  it("should list objects in a bucket filtered by a delimiter", function*() {
    const testObjects = [
      "akey1",
      "akey2",
      "akey3",
      "key/key1",
      "key1",
      "key2",
      "key3"
    ];
    yield Promise.all(
      testObjects.map(key =>
        s3Client
          .putObject({ Bucket: buckets[1], Key: key, Body: "Hello!" })
          .promise()
      )
    );
    const data = yield s3Client
      .listObjects({ Bucket: buckets[1], Delimiter: "/" })
      .promise();
    expect(data.Contents).to.have.lengthOf(6);
    expect(find(data.CommonPrefixes, { Prefix: "key/" })).to.exist;
  });

  it("should list folders in a bucket filtered by a prefix and a delimiter", function*() {
    const testObjects = [
      "folder1/file1.txt",
      "folder1/file2.txt",
      "folder1/folder2/file3.txt",
      "folder1/folder2/file4.txt",
      "folder1/folder2/file5.txt",
      "folder1/folder2/file6.txt",
      "folder1/folder4/file7.txt",
      "folder1/folder4/file8.txt",
      "folder1/folder4/folder5/file9.txt",
      "folder1/folder3/file10.txt"
    ];

    yield Promise.all(
      testObjects.map(key =>
        s3Client
          .putObject({ Bucket: buckets[5], Key: key, Body: "Hello!" })
          .promise()
      )
    );

    const data = yield s3Client
      .listObjects({ Bucket: buckets[5], Prefix: "folder1/", Delimiter: "/" })
      .promise();
    expect(data.CommonPrefixes).to.have.lengthOf(3);
    expect(find(data.CommonPrefixes, { Prefix: "folder1/folder2/" })).to.exist;
    expect(find(data.CommonPrefixes, { Prefix: "folder1/folder3/" })).to.exist;
    expect(find(data.CommonPrefixes, { Prefix: "folder1/folder4/" })).to.exist;
  });

  it("should list no objects because of invalid prefix", function*() {
    const data = yield s3Client
      .listObjects({ Bucket: buckets[1], Prefix: "myinvalidprefix" })
      .promise();
    expect(data.Contents).to.have.lengthOf(0);
  });

  it("should list no objects because of invalid marker", function*() {
    const data = yield s3Client
      .listObjects({
        Bucket: buckets[1],
        Marker: "myinvalidmarker"
      })
      .promise();
    expect(data.Contents).to.have.lengthOf(0);
  });

  it("should generate a few thousand small objects", function*() {
    const data = yield generateTestObjects(s3Client, buckets[2], 2000);
    for (const object of data) {
      expect(object.ETag).to.match(/[a-fA-F0-9]{32}/);
    }
  });

  it("should return one thousand small objects", function*() {
    yield generateTestObjects(s3Client, buckets[2], 2000);
    const data = yield s3Client.listObjects({ Bucket: buckets[2] }).promise();
    expect(data.IsTruncated).to.be.true;
    expect(data.Contents).to.have.lengthOf(1000);
  });

  it("should return 500 small objects", function*() {
    yield generateTestObjects(s3Client, buckets[2], 1000);
    const data = yield s3Client
      .listObjects({ Bucket: buckets[2], MaxKeys: 500 })
      .promise();
    expect(data.IsTruncated).to.be.true;
    expect(data.Contents).to.have.lengthOf(500);
  });

  it("should delete 500 small objects", function*() {
    yield generateTestObjects(s3Client, buckets[2], 500);
    yield Promise.all(
      times(500, i =>
        s3Client.deleteObject({ Bucket: buckets[2], Key: "key" + i }).promise()
      )
    );
  });

  it("should delete 500 small objects with deleteObjects", function*() {
    yield generateTestObjects(s3Client, buckets[2], 500);
    const deleteObj = { Objects: times(500, i => ({ Key: "key" + i })) };
    const data = yield s3Client
      .deleteObjects({ Bucket: buckets[2], Delete: deleteObj })
      .promise();
    expect(data.Deleted).to.exist;
    expect(data.Deleted).to.have.lengthOf(500);
    expect(find(data.Deleted, { Key: "key67" })).to.exist;
  });

  it("should not throw when using deleteObjects with zero objects", function*() {
    yield s3Client
      .deleteObjects({ Bucket: buckets[2], Delete: { Objects: [] } })
      .promise();
  });

  it("should return nonexistent objects as deleted with deleteObjects", function*() {
    const deleteObj = { Objects: [{ Key: "doesnotexist" }] };
    const data = yield s3Client
      .deleteObjects({ Bucket: buckets[2], Delete: deleteObj })
      .promise();
    expect(data.Deleted).to.exist;
    expect(data.Deleted).to.have.lengthOf(1);
    expect(find(data.Deleted, { Key: "doesnotexist" })).to.exist;
  });

  it("should reach the server with a bucket vhost", function*() {
    const body = yield request({
      url: s3Client.endpoint.href,
      headers: { host: buckets[0] + ".s3.amazonaws.com" },
      json: true
    });
    expect(body).to.include("ListBucketResult");
  });
});

describe("S3rver CORS Policy Tests", function() {
  const bucket = "foobars";
  let s3Client;

  before("Initialize bucket", function*() {
    let server;
    const [, port] = yield thunkToPromise(done => {
      server = new S3rver({
        port: 4569,
        silent: true
      }).run(done);
    });
    try {
      s3Client = new AWS.S3({
        accessKeyId: "123",
        secretAccessKey: "abc",
        endpoint: `http://localhost:${port}`,
        sslEnabled: false,
        s3ForcePathStyle: true
      });
      const params = {
        Bucket: bucket,
        Key: "image",
        Body: yield fs.readFile("./test/resources/image0.jpg"),
        ContentType: "image/jpeg"
      };
      yield s3Client.createBucket({ Bucket: bucket }).promise();
      yield s3Client.putObject(params).promise();
    } catch (err) {
      throw err;
    } finally {
      yield thunkToPromise(done => server.close(done));
    }
  });

  it("should add the Access-Control-Allow-Origin header for default (wildcard) configurations", function*() {
    const origin = "http://a-test.example.com";
    const params = { Bucket: bucket, Key: "image" };
    const url = s3Client.getSignedUrl("getObject", params);
    let server;
    yield thunkToPromise(done => {
      server = new S3rver({
        port: 4569,
        silent: true
      }).run(done);
    });
    try {
      const res = yield request({
        url,
        headers: { origin },
        resolveWithFullResponse: true
      });
      expect(res.statusCode).to.equal(200);
      expect(res.headers).to.have.property("access-control-allow-origin", "*");
    } catch (err) {
      throw err;
    } finally {
      yield thunkToPromise(done => server.close(done));
    }
  });

  it("should add the Access-Control-Allow-Origin header for a matching origin", function*() {
    const origin = "http://a-test.example.com";
    const params = { Bucket: bucket, Key: "image" };
    const url = s3Client.getSignedUrl("getObject", params);
    let server;
    yield thunkToPromise(done => {
      server = new S3rver({
        port: 4569,
        silent: true,
        cors: fs.readFileSync("./test/resources/cors_test1.xml")
      }).run(done);
    });
    try {
      const res = yield request({
        url,
        headers: { origin },
        resolveWithFullResponse: true
      });
      expect(res.statusCode).to.equal(200);
      expect(res.headers).to.have.property(
        "access-control-allow-origin",
        origin
      );
    } catch (err) {
      throw err;
    } finally {
      yield thunkToPromise(done => server.close(done));
    }
  });

  it("should match an origin to a CORSRule with a wildcard character", function*() {
    const origin = "http://foo.bar.com";
    const params = { Bucket: bucket, Key: "image" };
    const url = s3Client.getSignedUrl("getObject", params);
    let server;
    yield thunkToPromise(done => {
      server = new S3rver({
        port: 4569,
        silent: true,
        cors: fs.readFileSync("./test/resources/cors_test1.xml")
      }).run(done);
    });
    try {
      const res = yield request({
        url,
        headers: { origin },
        resolveWithFullResponse: true
      });
      expect(res.statusCode).to.equal(200);
      expect(res.headers).to.have.property(
        "access-control-allow-origin",
        origin
      );
    } catch (err) {
      throw err;
    } finally {
      yield thunkToPromise(done => server.close(done));
    }
  });

  it("should not add the Access-Control-Allow-Origin header for a non-matching origin", function*() {
    const origin = "http://b-test.example.com";
    const params = { Bucket: bucket, Key: "image" };
    const url = s3Client.getSignedUrl("getObject", params);
    let server;
    yield thunkToPromise(done => {
      server = new S3rver({
        port: 4569,
        silent: true,
        cors: fs.readFileSync("./test/resources/cors_test1.xml")
      }).run(done);
    });
    try {
      const res = yield request({
        url,
        headers: { origin },
        resolveWithFullResponse: true
      });
      expect(res.statusCode).to.equal(200);
      expect(res.headers).to.not.have.property("access-control-allow-origin");
    } catch (err) {
      throw err;
    } finally {
      yield thunkToPromise(done => server.close(done));
    }
  });

  it("should expose appropriate headers for a range request", function*() {
    const origin = "http://a-test.example.com";
    const params = { Bucket: bucket, Key: "image" };
    const url = s3Client.getSignedUrl("getObject", params);
    let server;
    yield thunkToPromise(done => {
      server = new S3rver({
        port: 4569,
        silent: true,
        cors: fs.readFileSync("./test/resources/cors_test1.xml")
      }).run(done);
    });
    try {
      const res = yield request({
        url,
        headers: { origin, range: "bytes=0-99" },
        resolveWithFullResponse: true
      });
      expect(res.statusCode).to.equal(206);
      expect(res.headers).to.have.property(
        "access-control-expose-headers",
        "Accept-Ranges, Content-Range"
      );
    } catch (err) {
      throw err;
    } finally {
      yield thunkToPromise(done => server.close(done));
    }
  });

  it("should respond to OPTIONS requests with allowed headers", function*() {
    const origin = "http://foo.bar.com";
    const params = { Bucket: bucket, Key: "image" };
    const url = s3Client.getSignedUrl("getObject", params);
    let server;
    yield thunkToPromise(done => {
      server = new S3rver({
        port: 4569,
        silent: true,
        cors: fs.readFileSync("./test/resources/cors_test1.xml")
      }).run(done);
    });
    try {
      const res = yield request({
        method: "OPTIONS",
        url,
        headers: {
          origin,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "Range, Authorization"
        },
        resolveWithFullResponse: true
      });
      expect(res.statusCode).to.equal(200);
      expect(res.headers).to.have.property("access-control-allow-origin", "*");
      expect(res.headers).to.have.property(
        "access-control-allow-headers",
        "range, authorization"
      );
    } catch (err) {
      throw err;
    } finally {
      yield thunkToPromise(done => server.close(done));
    }
  });

  it("should respond to OPTIONS requests with a Forbidden response", function*() {
    const origin = "http://a-test.example.com";
    const params = { Bucket: bucket, Key: "image" };
    const url = s3Client.getSignedUrl("getObject", params);
    let server;
    yield thunkToPromise(done => {
      server = new S3rver({
        port: 4569,
        silent: true,
        cors: fs.readFileSync("./test/resources/cors_test1.xml")
      }).run(done);
    });
    let error;
    try {
      yield request({
        method: "OPTIONS",
        url,
        headers: {
          origin,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "Range, Authorization"
        }
      });
    } catch (err) {
      error = err;
      expect(err.statusCode).to.equal(403);
    } finally {
      yield thunkToPromise(done => server.close(done));
      expect(error).to.exist;
    }
  });

  it("should respond to OPTIONS requests with a Forbidden response when CORS is disabled", function*() {
    const origin = "http://foo.bar.com";
    const params = { Bucket: bucket, Key: "image" };
    const url = s3Client.getSignedUrl("getObject", params);
    let server;
    yield thunkToPromise(done => {
      server = new S3rver({
        port: 4569,
        silent: true,
        cors: false
      }).run(done);
    });
    let error;
    try {
      yield request({
        method: "OPTIONS",
        url,
        headers: {
          origin,
          "Access-Control-Request-Method": "GET"
        },
        resolveWithFullResponse: true
      });
    } catch (err) {
      error = err;
      expect(err.statusCode).to.equal(403);
    } finally {
      yield thunkToPromise(done => server.close(done));
      expect(error).to.exist;
    }
  });
});

describe("S3rver Tests with Static Web Hosting", function() {
  let s3Client;
  let server;

  beforeEach("Reset site bucket", resetTmpDir);
  beforeEach("Start server", function*() {
    yield thunkToPromise(done => {
      server = new S3rver({
        port: 5694,
        silent: true,
        indexDocument: "index.html",
        errorDocument: "",
        directory: tmpDir
      }).run(done);
    });
    s3Client = new AWS.S3({
      accessKeyId: "123",
      secretAccessKey: "abc",
      endpoint: `http://localhost:${server.address().port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
  });

  afterEach("Close server", function(done) {
    server.close(done);
  });

  it("should upload a html page to / path", function*() {
    const bucket = "site";
    yield s3Client.createBucket({ Bucket: bucket }).promise();
    const data = yield s3Client
      .putObject({
        Bucket: bucket,
        Key: "index.html",
        Body: "<html><body>Hello</body></html>"
      })
      .promise();
    expect(data.ETag).to.match(/[a-fA-F0-9]{32}/);
  });

  it("should upload a html page to a directory path", function*() {
    const bucket = "site";
    yield s3Client.createBucket({ Bucket: bucket }).promise();
    const data = yield s3Client
      .putObject({
        Bucket: bucket,
        Key: "page/index.html",
        Body: "<html><body>Hello</body></html>"
      })
      .promise();
    expect(data.ETag).to.match(/[a-fA-F0-9]{32}/);
  });

  it("should get an index page at / path", function*() {
    const bucket = "site";
    yield s3Client.createBucket({ Bucket: bucket }).promise();
    const expectedBody = "<html><body>Hello</body></html>";
    yield s3Client
      .putObject({ Bucket: bucket, Key: "index.html", Body: expectedBody })
      .promise();
    const body = yield request(s3Client.endpoint.href + "site/");
    expect(body).to.equal(expectedBody);
  });

  it("should get an index page at /page/ path", function*() {
    const bucket = "site";
    yield s3Client.createBucket({ Bucket: bucket }).promise();
    const expectedBody = "<html><body>Hello</body></html>";
    yield s3Client
      .putObject({
        Bucket: bucket,
        Key: "page/index.html",
        Body: expectedBody
      })
      .promise();
    const body = yield request(s3Client.endpoint.href + "site/page/");
    expect(body).to.equal(expectedBody);
  });

  it("should get a 404 error page", function*() {
    const bucket = "site";
    yield s3Client.createBucket({ Bucket: bucket }).promise();
    let error;
    try {
      yield request(s3Client.endpoint.href + "site/page/not-exists");
    } catch (err) {
      error = err;
      expect(err.statusCode).to.equal(404);
      expect(err.response.headers).to.have.property(
        "content-type",
        "text/html"
      );
    }
    expect(error).to.exist;
  });
});

describe("S3rver Class Tests", function() {
  it("should merge default options with provided options", function() {
    const s3rver = new S3rver({
      hostname: "testhost",
      indexDocument: "index.html",
      errorDocument: "",
      directory: "./testdir",
      key: new Buffer([1, 2, 3]),
      cert: new Buffer([1, 2, 3]),
      removeBucketsOnClose: true
    });

    expect(s3rver.options).to.have.property("hostname", "testhost");
    expect(s3rver.options).to.have.property("port", 4578);
    expect(s3rver.options).to.have.property("silent", false);
    expect(s3rver.options).to.have.property("indexDocument", "index.html");
    expect(s3rver.options).to.have.property("errorDocument", "");
    expect(s3rver.options).to.have.property("directory", "./testdir");
    expect(s3rver.options).to.have.property("key");
    expect(s3rver.options).to.have.property("cert");
    expect(s3rver.options.key).to.be.an.instanceOf(Buffer);
    expect(s3rver.options.cert).to.be.an.instanceOf(Buffer);
    expect(s3rver.options).to.have.property("removeBucketsOnClose", true);
  });

  it("should support running on port 0", function*() {
    let server;
    const [, port] = yield thunkToPromise(done => {
      server = new S3rver({
        port: 0,
        silent: true
      }).run(done);
    });
    yield thunkToPromise(done => server.close(done));
    expect(port).to.be.above(0);
  });
});

describe("Data directory cleanup", function() {
  beforeEach("Reset buckets", resetTmpDir);

  it("Cleans up after close if the removeBucketsOnClose setting is true", function*() {
    const bucket = "foobars";

    let server;
    const [, port, directory] = yield thunkToPromise(done => {
      server = new S3rver({
        port: 4569,
        silent: true,
        removeBucketsOnClose: true
      }).run(done);
    });
    const s3Client = new AWS.S3({
      accessKeyId: "123",
      secretAccessKey: "abc",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    try {
      yield s3Client.createBucket({ Bucket: bucket }).promise();
      yield generateTestObjects(s3Client, bucket, 10);
    } catch (err) {
      throw err;
    } finally {
      yield thunkToPromise(done => server.close(done));
      yield expect(fs.exists(directory)).to.eventually.be.true;
      yield expect(fs.readdir(directory)).to.eventually.have.lengthOf(0);
    }
  });

  it("Does not clean up after close if the removeBucketsOnClose setting is false", function*() {
    const bucket = "foobars";

    let server;
    const [, port, directory] = yield thunkToPromise(done => {
      server = new S3rver({
        port: 4569,
        silent: true,
        removeBucketsOnClose: false
      }).run(done);
    });
    const s3Client = new AWS.S3({
      accessKeyId: "123",
      secretAccessKey: "abc",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    try {
      yield s3Client.createBucket({ Bucket: bucket }).promise();
      yield generateTestObjects(s3Client, bucket, 10);
    } catch (err) {
      throw err;
    } finally {
      yield thunkToPromise(done => server.close(done));
      yield expect(fs.exists(directory)).to.eventually.be.true;
      yield expect(fs.readdir(directory)).to.eventually.have.lengthOf(1);
    }
  });

  it("Does not clean up after close if the removeBucketsOnClose setting is not set", function*() {
    const bucket = "foobars";

    let server;
    const [, port, directory] = yield thunkToPromise(done => {
      server = new S3rver({
        port: 4569,
        silent: true
      }).run(done);
    });
    const s3Client = new AWS.S3({
      accessKeyId: "123",
      secretAccessKey: "abc",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    try {
      yield s3Client.createBucket({ Bucket: bucket }).promise();
      yield generateTestObjects(s3Client, bucket, 10);
    } catch (err) {
      throw err;
    } finally {
      yield thunkToPromise(done => server.close(done));
      yield expect(fs.exists(directory)).to.eventually.be.true;
      yield expect(fs.readdir(directory)).to.eventually.have.lengthOf(1);
    }
  });

  it("Can delete a bucket that is empty after some key that includes a directory has been deleted", function*() {
    const bucket = "foobars";

    let server;
    const [, port] = yield thunkToPromise(done => {
      server = new S3rver({
        port: 4569,
        silent: true
      }).run(done);
    });
    const s3Client = new AWS.S3({
      accessKeyId: "123",
      secretAccessKey: "abc",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    try {
      yield s3Client.createBucket({ Bucket: bucket }).promise();
      yield s3Client
        .putObject({ Bucket: bucket, Key: "foo/foo.txt", Body: "Hello!" })
        .promise();
      yield s3Client
        .deleteObject({ Bucket: bucket, Key: "foo/foo.txt" })
        .promise();
      yield s3Client.deleteBucket({ Bucket: bucket }).promise();
    } catch (err) {
      throw err;
    } finally {
      yield thunkToPromise(done => server.close(done));
    }
  });

  it("Can put an object in a bucket that is empty after some key that does not include a directory has been deleted", function*() {
    const bucket = "foobars";

    let server;
    const [, port] = yield thunkToPromise(done => {
      server = new S3rver({
        port: 4569,
        silent: true
      }).run(done);
    });
    const s3Client = new AWS.S3({
      accessKeyId: "123",
      secretAccessKey: "abc",
      endpoint: `http://localhost:${port}`,
      sslEnabled: false,
      s3ForcePathStyle: true
    });
    try {
      yield s3Client.createBucket({ Bucket: bucket }).promise();
      yield s3Client
        .putObject({ Bucket: bucket, Key: "foo.txt", Body: "Hello!" })
        .promise();
      yield s3Client.deleteObject({ Bucket: bucket, Key: "foo.txt" }).promise();
      yield s3Client
        .putObject({ Bucket: bucket, Key: "foo2.txt", Body: "Hello2!" })
        .promise();
    } catch (err) {
      throw err;
    } finally {
      yield thunkToPromise(done => server.close(done));
    }
  });
});
