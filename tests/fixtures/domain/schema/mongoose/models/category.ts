import { Schema, model } from 'mongoose';
import { tagSchema } from './tag';

export const Category = model('Category', new Schema({ name: { type: String, required: true } }));
export const Person = model('Person', new Schema({ name: String }), 'people_custom');
export const Tag = model('Tag', tagSchema);
export const Again = model('Category');
