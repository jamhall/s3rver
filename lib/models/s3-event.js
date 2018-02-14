'use strict';
const crypto = require('crypto');

const S3Event = function (eventData, reqParams) {
  const {reqHeaders,sourceIp} = reqParams;
  let eventName = '';
  const s3Object = {
    "key": eventData.S3Item.key,
    "sequencer": ('00' + (Math.floor(Date.now())).toString(16)).toUpperCase()
  };
  switch (eventData.eventType) {
    case 'Copy':
      eventName = 'ObjectCreated:Copy';
      s3Object.size = eventData.S3Item.size;
      break;

    case 'Put':
      eventName = 'ObjectCreated:Put';
      s3Object.size = eventData.S3Item.size;
      s3Object.eTag = eventData.S3Item.md5;
      break;

    case 'Post':
      eventName = 'ObjectCreated:Post';
      s3Object.size = eventData.S3Item.size;
      s3Object.eTag = eventData.S3Item.md5;
      break;

    case 'Delete':
      eventName = 'ObjectRemoved:Delete';
      break;
  }

  const event = {
    "Records": [
      {
        "eventVersion": "2.0",
        "eventSource": "aws:s3",
        "awsRegion": reqHeaders.host,
        "eventTime": eventData.S3Item.creationDate || new Date().toISOString(),
        "eventName": eventName,
        "userIdentity": {
          "principalId": 'AWS:' + randomString(21).toUpperCase(),
        },
        "requestParameters": {
          "sourceIPAddress": sourceIp
        },
        "responseElements": {
          "x-amz-request-id": randomString(16).toUpperCase(),
          "x-amz-id-2": crypto.createHash('sha256').update(reqHeaders.host).digest('base64')
        },
        "s3": {
          "s3SchemaVersion": "1.0",
          "configurationId": randomString(8) + '-' + randomString(4) + '-' + randomString(4) + '-' + randomString(4) + '-' + randomString(12),
          "bucket": {
            "name": eventData.bucket,
            "ownerIdentity": {
              "principalId": randomString(14).toUpperCase()
            },
            "arn": "arn:aws:s3: : :" + eventData.bucket
          },
          "object": s3Object
        }
      }
    ]
  }
  return event;
};

const randomString = function (length) {
  let randString = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < length; i++) {
    randString += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return randString;
}

module.exports = S3Event;