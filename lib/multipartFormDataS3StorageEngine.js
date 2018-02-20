/**
 * A multer storage engine that uses the  s3rver file-store to save the upload
 */
function S3Storage(opts) {
  this.fileStore = opts.fileStore;
}

S3Storage.prototype._handleFile = function(req, file, cb) {
  // modify the content-type before saving as S3 metadata
  const modifiedHeaders = Object.assign({}, req.headers, {"content-type": "binary/octet-stream"});
  const reqCopy = Object.assign({}, req);
  reqCopy.headers = modifiedHeaders;

  this.fileStore.postObject({ name: req.body.bucket }, req.body.key, reqCopy, file, cb);
}

S3Storage.prototype._removeFile = function() {
  throw new Error("Removal of file by POST is not supported");
}

module.exports = function(opts) {
  return new S3Storage(opts)
}
