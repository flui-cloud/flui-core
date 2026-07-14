import { DataSource } from 'typeorm';
import { config } from 'dotenv';
import { migrations } from '../migrations';
import { entities } from './entities';

// Load environment variables from .env file
config();

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: Number.parseInt(process.env.DB_PORT || '5432'),
  username: process.env.DB_USERNAME || 'developer',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'myapp_dev',
  entities,
  migrations,
  synchronize: false,
  logging: true,
});
