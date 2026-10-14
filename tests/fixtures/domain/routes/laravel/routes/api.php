<?php

use Illuminate\Support\Facades\Route;

Route::get('/user', [UserController::class, 'show']);
Route::apiResource('orders', Api\OrderController::class);
