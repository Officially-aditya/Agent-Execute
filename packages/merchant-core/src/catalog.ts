import type { Product } from '../../shared/src/index.js';

export const MERCHANT_ID = 'merchant_demo';
export const CURRENCY = 'INR' as const;

export const SEED_PRODUCTS: Product[] = [
  { id: 'milk_1l', name: 'Full Cream Milk 1L', category: 'dairy', price: 7200, inventory: 30, active: true },
  { id: 'milk_toned_1l', name: 'Toned Milk 1L', category: 'dairy', price: 6200, inventory: 30, active: true },
  { id: 'bread_white', name: 'Classic White Bread', category: 'bakery', price: 4800, inventory: 20, active: true },
  { id: 'bread_wheat', name: 'Whole Wheat Bread', category: 'bakery', price: 5800, inventory: 20, active: true },
  { id: 'eggs_6', name: 'Farm Eggs 6 Pack', category: 'breakfast', price: 6500, inventory: 24, active: true },
  { id: 'eggs_12', name: 'Farm Eggs 12 Pack', category: 'breakfast', price: 11000, inventory: 16, active: true },
  { id: 'cereal_basic', name: 'Classic Cereal', category: 'breakfast', price: 23000, inventory: 12, active: true },
  { id: 'cereal_value', name: 'Value Corn Flakes', category: 'breakfast', price: 16500, inventory: 18, active: true },
  { id: 'rice_1kg', name: 'Everyday Rice 1kg', category: 'staples', price: 9800, inventory: 25, active: true },
  { id: 'coffee_100g', name: 'Instant Coffee 100g', category: 'beverages', price: 14500, inventory: 14, active: true },
  { id: 'butter_100g', name: 'Salted Butter 100g', category: 'dairy', price: 6200, inventory: 18, active: true },
  { id: 'juice_1l', name: 'Orange Juice 1L', category: 'beverages', price: 9500, inventory: 16, active: true },
  { id: 'tea_250g', name: 'Assam Tea 250g', category: 'beverages', price: 12500, inventory: 15, active: true },
  { id: 'biscuits_pack', name: 'Tea Biscuits', category: 'snacks', price: 3500, inventory: 40, active: true },
];
