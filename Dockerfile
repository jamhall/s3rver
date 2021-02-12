FROM node:12-alpine
WORKDIR /src
COPY package* ./
ENV NODE_ENV=production
RUN npm install
EXPOSE 8080
VOLUME /data
COPY . .
CMD ["node","bin/s3rver.js", "-p", "8080", "-d", "/data"]
