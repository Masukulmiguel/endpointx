import { Router } from 'express';
import authRoutes from './auth';
import deviceRoutes from './devices';
import commandRoutes from './commands';
import userRoutes from './users';
import roleRoutes from './roles';
import alertRoutes from './alerts';
import securityRoutes from './security';
import auditRoutes from './audit';
import dashboardRoutes from './dashboard';
import settingsRoutes from './settings';
import networkRoutes from './network';

const router = Router();

router.use('/auth', authRoutes);
router.use('/devices', deviceRoutes);
router.use('/commands', commandRoutes);
router.use('/users', userRoutes);
router.use('/roles', roleRoutes);
router.use('/alerts', alertRoutes);
router.use('/security', securityRoutes);
router.use('/audit', auditRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/settings', settingsRoutes);
router.use('/network', networkRoutes);

export default router;
