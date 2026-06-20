FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 7860
ENV PORT=7860
ENV ADMIN_PASSWORD=change-this-password
CMD ["node", "server.js"]
