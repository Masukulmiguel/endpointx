import { Router } from 'express';
import { login, register, logout, refreshToken, changePassword, getProfile, updateProfile } from '../controllers/authController';
import { authenticate } from '../middleware/auth';
import { authLimiter } from '../middleware/rateLimiter';
import { validate } from '../middleware/validation';
import { LoginSchema, RegisterSchema } from '../utils/validators';

const router = Router();

router.post('/login', authLimiter, validate(LoginSchema), login);
router.post('/register', authLimiter, validate(RegisterSchema), register);
router.post('/logout', authenticate, logout);
router.post('/refresh', refreshToken);
router.put('/change-password', authenticate, changePassword);
router.get('/profile', authenticate, getProfile);
router.put('/profile', authenticate, updateProfile);

export default router;
