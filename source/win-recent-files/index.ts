import windowRegister from '../common/modules/window-register'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'

windowRegister()
  .then(() => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    createApp(App).use(createPinia()).mount('#app')
  })
  .catch(error => console.error(error))
