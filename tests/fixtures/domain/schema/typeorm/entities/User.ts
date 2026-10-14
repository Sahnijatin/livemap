import { Entity, PrimaryColumn, Column, ManyToMany } from 'typeorm';

@Entity()
export class User {
  @PrimaryColumn()
  id: number;

  @Column()
  email: string;

  @ManyToMany('Role')
  roles: Role[];
}

// @Entity('ghosts') export class Ghost {}
export class NotAnEntity {
  @Column()
  ignored: string;
}
