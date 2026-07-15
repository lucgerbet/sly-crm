/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#FAFAF8',
        surface: '#FFFFFF',
        accent: '#1A1A1A',
        ink: { primary: '#1A1A1A', secondary: '#6B7280' },
        line: '#E5E5E0',
        score: { green: '#1D9E75', amber: '#EF9F27', red: '#E24B4A', blue: '#3B82F6' },
      },
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
      borderRadius: { card: '10px' },
    },
  },
  plugins: [],
};
