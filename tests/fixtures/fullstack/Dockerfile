FROM node:20-alpine
WORKDIR /srv
COPY apps/api ./apps/api
COPY prisma ./prisma
RUN npm --prefix apps/api install --omit=dev
EXPOSE 4000
CMD ["node", "apps/api/dist/index.js"]
