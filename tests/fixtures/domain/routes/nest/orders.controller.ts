import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { OrdersService } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  findAll() {
    return this.orders.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.orders.findOne(id);
  }

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    return this.orders.create(body);
  }

  // @Delete(':id')
  // remove(@Param('id') id: string) {}
}

@Controller({ path: 'admin/orders' })
export class AdminOrdersController {
  @Delete(':id')
  public async purge(@Param('id') id: string) {}
}
