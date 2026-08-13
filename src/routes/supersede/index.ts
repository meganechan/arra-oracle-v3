/**
 * Supersede Routes (Elysia) — composes /api/supersede (GET/POST),
 * /api/supersede/mark (POST, id-form), + /api/supersede/chain/:path.
 */

import { Elysia } from 'elysia';
import { supersedeListEndpoint } from './list.ts';
import { supersedeChainEndpoint } from './chain.ts';
import { supersedeCreateEndpoint } from './create.ts';
import { supersedeMarkEndpoint } from './mark.ts';

export const supersedeRoutes = new Elysia({ prefix: '/api' })
  .use(supersedeListEndpoint)
  .use(supersedeChainEndpoint)
  .use(supersedeCreateEndpoint)
  .use(supersedeMarkEndpoint);
