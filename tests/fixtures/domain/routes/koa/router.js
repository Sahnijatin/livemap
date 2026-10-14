const Router = require('@koa/router');
const users = require('./users');

const router = new Router();

router.get('/books', listBooks);
router.post('/books/:id/loans', async (ctx) => {
  ctx.status = 201;
});
router.use('/users', users.routes());

module.exports = router;
