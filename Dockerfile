FROM node:22-slim
WORKDIR /app
COPY package*.json ./
# tsx (the runtime) is a devDependency, so install everything.
RUN npm ci --no-audit --no-fund
COPY . .
RUN mkdir -p data && chown -R node:node /app
USER node
# Render injects PORT; Hugging Face Spaces expects 7860 (set app_port: 7860 in the Space README).
ENV HOST=0.0.0.0 PORT=7860 MODE=sandbox
EXPOSE 7860
CMD ["npm", "start"]
