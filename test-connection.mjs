import { supabase } from './supabaseClient.js'

const { data, error } = await supabase.from('test').select('*').limit(1)
console.log('Query error (expected if no tables yet):', error?.message ?? 'none')

const { data: sessionData } = await supabase.auth.getSession()
console.log('Auth reachable:', !!sessionData)
