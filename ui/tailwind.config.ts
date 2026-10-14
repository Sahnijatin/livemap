import type { Config } from 'tailwindcss';

const v = (name: string) => `var(--${name})`;

/** Tokens come from CSS custom properties in src/styles.css (light and dark), as in the prototype. */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: v('bg'), ink: v('ink'), ink2: v('ink2'), ink3: v('ink3'),
        hair: v('hair'), hair2: v('hair2'), card: v('card'), glass: v('glass'), pane: v('pane'),
        blue: v('blue'), purple: v('purple'), teal: v('teal'), orange: v('orange'),
        green: v('green'), red: v('red'), indigo: v('indigo'), pink: v('pink'),
        'blue-t': v('blue-t'), 'purple-t': v('purple-t'), 'teal-t': v('teal-t'), 'orange-t': v('orange-t'),
        'green-t': v('green-t'), 'red-t': v('red-t'), 'indigo-t': v('indigo-t'), 'pink-t': v('pink-t'),
      },
      fontFamily: { sans: v('sans').split(','), display: v('display').split(','), mono: v('mono').split(',') },
      boxShadow: { soft: v('shadow'), lg: v('shadow-lg') },
      borderRadius: { pane: '20px', card: '14px' },
      transitionTimingFunction: { ease: v('ease'), spring: v('spring') },
      keyframes: {
        pop: { from: { opacity: '0', transform: 'translateX(-10px) scale(.96)' } },
        swapin: { from: { opacity: '0', transform: 'translateX(16px)' } },
        fin: { from: { opacity: '0', transform: 'translateY(14px) scale(.97)' } },
      },
      animation: {
        pop: 'pop .6s var(--spring) both',
        swapin: 'swapin .5s var(--ease) both',
        fin: 'fin .6s var(--ease) both',
      },
    },
  },
  plugins: [],
} satisfies Config;
