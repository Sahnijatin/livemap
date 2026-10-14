const url = process.env.DATABASE_URL;
const key = process.env['STRIPE_KEY'];
const mode = import.meta.env.VITE_MODE;
const deno = Deno.env.get('DENO_TOKEN');
// const old = process.env.COMMENTED_OUT;
/* process.env.BLOCK_COMMENTED */
const dyn = process.env[key];
