import { MotionGlobalConfig } from 'framer-motion';

// framer-motion animations finish instantly in tests, so exits and springs never leave timing-dependent state behind.
MotionGlobalConfig.skipAnimations = true;
