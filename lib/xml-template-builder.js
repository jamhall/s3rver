"use strict";

const jstoxml = require("jstoxml");

const DISPLAY_NAME = "S3rver";

exports.buildBuckets = function(buckets) {
  return jstoxml.toXML(
    {
      _name: "ListAllMyBucketsResult",
      _attrs: { xmlns: "http://doc.s3.amazonaws.com/2006-03-01" },
      _content: {
        Owner: {
          ID: 123,
          DisplayName: DISPLAY_NAME
        },
        Buckets: buckets.map(bucket => ({
          Bucket: {
            Name: bucket.name,
            CreationDate: bucket.creationDate.toISOString()
          }
        }))
      }
    },
    {
      header: true,
      indent: "  "
    }
  );
};

exports.buildBucketQuery = function(bucketName, options, data) {
  const xml = {
    _name: "ListBucketResult",
    _attrs: { xmlns: "http://doc.s3.amazonaws.com/2006-03-01" },
    _content: [
      {
        IsTruncated: data.isTruncated || false,
        Marker: options.marker || "",
        Name: bucketName,
        Prefix: options.prefix || "",
        MaxKeys: options.maxKeys
      },
      ...data.objects.map(object => ({
        Contents: {
          Key: object.key,
          LastModified: object.lastModifiedDate.toISOString(),
          ETag: object.metadata["etag"],
          Size: object.size,
          StorageClass: "STANDARD",
          Owner: {
            ID: 123,
            DisplayName: DISPLAY_NAME
          }
        }
      })),
      ...data.commonPrefixes.map(prefix => ({
        CommonPrefixes: { Prefix: prefix }
      }))
    ]
  };
  return jstoxml.toXML(xml, {
    header: true,
    indent: "  "
  });
};

exports.buildBucketNotFound = function(bucketName) {
  return jstoxml.toXML(
    {
      Error: {
        Code: "NoSuchBucket",
        Message: "The specified bucket does not exist",
        Resource: bucketName,
        RequestId: 1
      }
    },
    {
      header: true,
      indent: "  "
    }
  );
};

exports.buildBucketNotEmpty = function(bucketName) {
  return jstoxml.toXML(
    {
      Error: {
        Code: "BucketNotEmpty",
        Message: "The bucket your tried to delete is not empty",
        Resource: bucketName,
        RequestId: 1,
        HostId: 2
      }
    },
    {
      header: true,
      indent: "  "
    }
  );
};

exports.buildKeyNotFound = function(key) {
  return jstoxml.toXML(
    {
      Error: {
        Code: "NoSuchKey",
        Message: "The specified key does not exist",
        Resource: key,
        RequestId: 1
      }
    },
    {
      header: true,
      indent: "  "
    }
  );
};

exports.buildObjectsDeleted = function(keys) {
  return jstoxml.toXML(
    {
      _name: "DeleteResult",
      _attrs: { xmlns: "http://s3.amazonaws.com/doc/2006-03-01/" },
      _content: keys.map(k => ({ Deleted: { Key: k } }))
    },
    {
      header: true,
      indent: "  "
    }
  );
};

exports.buildError = function(code, message) {
  return jstoxml.toXML(
    {
      Error: {
        Code: code,
        Message: message,
        RequestId: 1
      }
    },
    {
      header: true,
      indent: "  "
    }
  );
};

exports.buildAcl = function() {
  return jstoxml.toXML(
    {
      _name: "AccessControlPolicy",
      _attrs: { xmlns: "http://doc.s3.amazonaws.com/2006-03-01" },
      _content: {
        Owner: {
          ID: 123,
          DisplayName: DISPLAY_NAME
        },
        AccessControlList: {
          Grant: {
            _name: "Grantee",
            _attrs: {
              "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
              "xsi:type": "CanonicalUser"
            },
            _content: {
              ID: "abc",
              DisplayName: "You"
            }
          },
          Permission: "FULL_CONTROL"
        }
      }
    },
    {
      header: true,
      indent: "  "
    }
  );
};

exports.buildCopyObject = function(metadata) {
  return jstoxml.toXML(
    {
      CopyObjectResult: {
        LastModified: new Date(metadata["last-modified"]).toISOString(),
        ETag: metadata["etag"]
      }
    },
    {
      header: true,
      indent: "  "
    }
  );
};

exports.buildInitiateMultipartUploadResult = function(bucket, key, uploadId) {
  return jstoxml.toXML(
    {
      InitiateMultipartUploadResult: {
        Bucket: bucket,
        Key: key,
        UploadId: uploadId
      }
    },
    {
      header: true,
      indent: "  "
    }
  );
};

exports.buildCompleteMultipartUploadResult = function(
  bucket,
  key,
  location,
  md5
) {
  return jstoxml.toXML(
    {
      CompleteMultipartUploadResult: {
        Location: location,
        Bucket: bucket,
        Key: key,
        ETag: JSON.stringify(md5)
      }
    },
    {
      header: true,
      indent: " "
    }
  );
};
