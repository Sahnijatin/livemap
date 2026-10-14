const mongoose = require('mongoose');
const { Schema } = mongoose;

const orderSchema = new Schema({
  customer: String,
  total: { type: Number, required: true },
  code: { type: String, unique: true, required: [true, 'code is required'] },
  user: { type: Schema.Types.ObjectId, ref: 'User' },
  items: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Item' }],
  tags: [String],
  address: { street: String, city: String },
  'created_at': { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('Order', orderSchema);
