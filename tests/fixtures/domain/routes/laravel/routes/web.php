<?php

use App\Http\Controllers\OrderController;
use Illuminate\Support\Facades\Route;

Route::get('/', function () {
    return view('welcome');
});

Route::get('/orders', [OrderController::class, 'index'])->name('orders.index');
Route::post('/orders', 'OrderController@store');
Route::resource('photos', PhotoController::class);
Route::resource('tags', TagController::class)->only(['index', 'show']);

Route::prefix('admin')->middleware('auth')->group(function () {
    Route::get('/users/{user}', [AdminController::class, 'user']);
    Route::group(['prefix' => 'reports'], function () {
        Route::match(['get', 'post'], '/daily', DailyReport::class);
    });
});

// Route::get('/commented', fn () => 1);
# Route::get('/hash-commented', fn () => 1);
Route::any('/fallback', fn () => abort(404));
