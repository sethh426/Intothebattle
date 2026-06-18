import express from 'express';
import db from '../db/db.js';
import {
  getActiveUserCounts,
  injectActiveUserMetrics,
} from '../services/adminUserCounts.js';
import adminCoreRoutes from './adminCore.js';

const router = express.Router();

router.use((req, res, next) => {
  if (req.method !== 'GET' || req.path !== '/') return next();

  const send = res.send.bind(res);
  res.send = (body) => {
    if (typeof body !== 'string') return send(body);
    return send(injectActiveUserMetrics(body, getActiveUserCounts(db)));
  };
  next();
});

router.use(adminCoreRoutes);

export default router;
