FROM node:11.6-alpine

# Intall system deps
RUN apk --no-cache add --virtual native-deps build-base python2 postgresql-dev

# Copy all application files
COPY . .

# Remove deps
RUN rm node_modules -Rf

# Install deps
RUN npm install

# Run app
CMD npm start
