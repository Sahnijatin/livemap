import express from 'express';
import ordersRouter from './routes/orders';

const app = express();
app.use(express.json());
app.use('/api', ordersRouter);

app.listen(Number(process.env.PORT ?? 4000));
