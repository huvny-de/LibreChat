const cookies = require('cookie');
const passport = require('passport');
const { isEnabled } = require('@librechat/api');

/**
 * Custom Middleware to handle JWT authentication, with support for OpenID token reuse
 * Switches between JWT and OpenID authentication based on cookies and environment settings
 * When ALLOW_UNAUTH_ACCESS=true, falls back to the shared anonymous user if JWT is missing/invalid
 */
const requireJwtAuth = (req, res, next) => {
  const cookieHeader = req.headers.cookie;
  const tokenProvider = cookieHeader ? cookies.parse(cookieHeader).token_provider : null;

  if (tokenProvider === 'openid' && isEnabled(process.env.OPENID_REUSE_TOKENS)) {
    return passport.authenticate('openidJwt', { session: false })(req, res, next);
  }

  if (!isEnabled(process.env.ALLOW_UNAUTH_ACCESS)) {
    return passport.authenticate('jwt', { session: false })(req, res, next);
  }

  return passport.authenticate('jwt', { session: false }, async (err, user) => {
    if (user) {
      req.user = user;
      return next();
    }
    try {
      const { findUser } = require('~/models');
      const anonEmail = process.env.ANON_USER_EMAIL;
      const defaultUser = anonEmail
        ? await findUser({ email: anonEmail })
        : await findUser({});
      if (defaultUser) {
        defaultUser.id = defaultUser._id.toString();
        req.user = defaultUser;
        return next();
      }
    } catch (e) {
      // fall through to 401
    }
    return res.status(401).json({ message: 'Unauthorized' });
  })(req, res, next);
};

module.exports = requireJwtAuth;
