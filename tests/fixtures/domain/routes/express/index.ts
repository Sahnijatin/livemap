import express from 'express';
import ordersRouter from './routes/orders';
import { router as usersRouter } from './routes/users';
const legacy = require('./routes/legacy');

const app = express();
const local = express.Router();

app.use(express.json());
app.use('/api', ordersRouter);
app.use('/users', requireAuth, usersRouter);
app.use('/legacy', legacy);
app.use('/local', local);

app.get('/health', (req, res) => res.send('ok'));
// app.get('/old', oldHandler);
/* app.post('/older', olderHandler); */
local.put('/settings/:key', saveSetting);
app.get('env');

app.listen(3000);
