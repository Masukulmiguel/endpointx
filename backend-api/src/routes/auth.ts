import { Router } from 'express';
import { login, inviteUser, logout, refreshToken, changePassword, getProfile, updateProfile } from '../controllers/authController';
import { authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { authLimiter } from '../middleware/rateLimiter';
import { validate } from '../middleware/validation';
import { LoginSchema } from '../utils/validators';

const router = Router();

router.post('/login', authLimiter, validate(LoginSchema), login);
router.post('/invite', authenticate, requirePermission('users.manage'), inviteUser);
router.post('/logout', authenticate, logout);
router.post('/refresh', refreshToken);
router.put('/change-password', authenticate, changePassword);
router.get('/profile', authenticate, getProfile);
router.put('/profile', authenticate, updateProfile);

export default router;
