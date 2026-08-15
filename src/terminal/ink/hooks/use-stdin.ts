import { useContext } from 'react'
import StdinContext from 'src/terminal/ink/components/StdinContext.js'

/**
 * `useStdin` is a React hook, which exposes stdin stream.
 */
const useStdin = () => useContext(StdinContext)
export default useStdin
