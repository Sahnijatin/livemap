import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, OneToMany, JoinColumn } from 'typeorm';
import { User } from './User';
import { OrderItem } from './OrderItem';

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'numeric', precision: 10, scale: 2 })
  total: number;

  @Column({ nullable: true })
  note: string;

  @Column({ unique: true })
  code: string;

  @Column()
  discount?: number;

  @Column({ type: 'text' })
  coupon: string | null;

  @ManyToOne(() => User, (user) => user.orders, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @OneToMany(type => OrderItem, item => item.order)
  items: OrderItem[];

  @Column({ type: 'varchar', nullable: false })
  public status!: string;

  total2(): number {
    return 1;
  }
}
