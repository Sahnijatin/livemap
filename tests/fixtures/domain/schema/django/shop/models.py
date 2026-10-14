from django.conf import settings
from django.db import models


class Timestamped(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        abstract = True


class Customer(models.Model):
    email = models.EmailField(unique=True)
    name = models.CharField(max_length=100)
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    objects = models.Manager()


class Order(Timestamped):
    code = models.CharField(max_length=20, primary_key=True)
    customer = models.ForeignKey('Customer', on_delete=models.CASCADE, related_name='orders')
    note = models.TextField(null=True, blank=True)
    tags = models.ManyToManyField('Tag')
    parent = models.ForeignKey('self', null=True, on_delete=models.SET_NULL)

    class Meta:
        db_table = 'orders'
        ordering = ['-created_at']

    def __str__(self):
        return self.code
