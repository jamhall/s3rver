FROM ubuntu:20.04
RUN apt-get update && apt-get install -y wget gettext-base && rm -rf /var/lib/apt/lists/*
ARG S3TEST_REVISION=master
RUN mkdir /opt/s3test \
&& wget https://github.com/ceph/s3-tests/archive/${S3TEST_REVISION}.tar.gz -O /tmp/s3test.tar.gz \
&& tar xvzf /tmp/s3test.tar.gz --strip 1 -C /opt/s3test \
&& rm /tmp/s3test.tar.gz
WORKDIR /opt/s3test
# local patch to enable container
RUN sed -i 's/sudo apt-get/apt-get/' ./bootstrap \
&& apt-get update \
&& DEBIAN_FRONTEND=noninteractive  ./bootstrap \
&& rm -rf /var/lib/apt/lists/*
COPY ./s3tests.conf.template /etc/s3tests.conf.template
ENV S3TEST_CONF=/etc/s3tests.conf
ENV S3TEST_HOST=localhost
ENV S3TEST_MAIN_USERID=123456789000
ENV S3TEST_MAIN_ACCESS_KEY=S3RVER
ENV S3TEST_MAIN_SECRET_KEY=S3RVER
ENV S3TEST_ALT_USERID=123456789000
ENV S3TEST_MAIN_ACCESS_KEY=S3RVER
ENV S3TEST_MAIN_SECRET_KEY=S3RVER
ENV S3TEST_TENANT_USERID=123456789000
ENV S3TEST_MAIN_ACCESS_KEY=S3RVER
ENV S3TEST_MAIN_SECRET_KEY=S3RVER
COPY ./docker-entrypoint.sh /usr/bin/docker-entrypoint.sh
ENTRYPOINT [ "docker-entrypoint.sh" ]
CMD ["./virtualenv/bin/nosetests"]
