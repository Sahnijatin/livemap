Rails.application.routes.draw do
  root 'pages#home'
  get '/about', to: 'pages#about'
  post 'login' => 'sessions#create'
  resources :orders
  resources :products, only: [:index, :show]

  namespace :api do
    namespace :v1 do
      resources :users, except: [:new, :edit, :destroy]
      get 'status', to: 'status#show'
    end
    delete '/sessions/:id', to: 'sessions#destroy'
  end

  # get '/commented', to: 'x#y'
=begin
  get '/block-commented', to: 'x#y'
=end
  resources :invoices do
    member do
      patch :ship
    end
    resources :items, only: :index
  end
  resource :profile, only: [:show, :update]
  match '/search', to: 'search#run', via: [:get, :post]
end
