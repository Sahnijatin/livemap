import 'package:go_router/go_router.dart';

final router = GoRouter(
  initialLocation: '/',
  routes: [
    GoRoute(
      path: '/',
      builder: (context, state) => const HomeScreen(),
      routes: [
        GoRoute(
          path: 'orders/:id',
          name: 'order',
          builder: (context, state) => OrderScreen(id: state.pathParameters['id']!),
        ),
      ],
    ),
    ShellRoute(
      builder: (context, state, child) => AppShell(child: child),
      routes: [
        GoRoute(path: '/settings', pageBuilder: (context, state) => NoTransitionPage(child: SettingsScreen())),
        // GoRoute(path: '/old', builder: (c, s) => Old()),
      ],
    ),
  ],
);
