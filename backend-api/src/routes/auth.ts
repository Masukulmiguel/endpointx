import { Router } from 'express';
import { login, register, forgotPassword, resetPassword, inviteUser, logout, refreshToken, changePassword, getProfile, updateProfile, mfaVerify } from '../controllers/authController';
import { authenticate } from '../middleware/auth';
import { requirePermission } from '../middleware/rbac';
import { authLimiter } from '../middleware/rateLimiter';
import { validate } from '../middleware/validation';
import { LoginSchema, RegisterSchema, ForgotPasswordSchema, ResetPasswordSchema } from '../utils/validators';

const router = Router();

router.post('/login', authLimiter, validate(LoginSchema), login);
router.post('/register', authLimiter, validate(RegisterSchema), register);
router.post('/forgot-password', authLimiter, validate(ForgotPasswordSchema), forgotPassword);
router.post('/reset-password', authLimiter, validate(ResetPasswordSchema), resetPassword);
router.post('/mfa-verify', authLimiter, mfaVerify);
router.post('/invite', authenticate, requirePermission('users.manage'), inviteUser);
router.post('/logout', authenticate, logout);
router.post('/refresh', refreshToken);
router.put('/change-password', authenticate, changePassword);
router.get('/profile', authenticate, getProfile);
router.put('/profile', authenticate, updateProfile);

export default router;
