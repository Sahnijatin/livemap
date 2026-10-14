from django.urls import include, path, re_path
from . import views

urlpatterns = [
    path('', views.index, name='index'),
    path('orders/<int:pk>/', views.detail, name='detail'),
    path('orders/<slug:slug>/edit/', views.OrderEdit.as_view(), name='edit'),
    re_path(r'^archive/(?P<year>[0-9]{4})/$', views.archive),
    path('api/', include('orders.urls')),
    path('accounts/', include(('accounts.urls', 'accounts'), namespace='accounts')),
    # path('old/', views.old),
]
